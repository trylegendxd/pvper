// server/sockets/liarsBarSocket.js
// ============================================================================
//  /lb namespace — real player-vs-player "Liar's Bar".
//
//  Matchmaking queues by (lobbySize, bet). When `size` players are queued at
//  the same bet a match starts: every ante is escrowed, then the server runs
//  the whole turn loop. Each round a random table card (A/K/Q) is chosen and
//  every player is dealt 5 cards. On your turn you either PLAY 1-3 cards face
//  down (claiming they're the table card) or call LIAR on the previous play.
//  A call reveals those cards: if they were all the table card or a Joker the
//  caller pulls the trigger, otherwise the bluffer does. Each player's revolver
//  has 6 chambers + 1 bullet that advances every pull. Last player alive takes
//  the pot. Everything money/random is server-authoritative — clients only send
//  their choices. The card the bullet sits in is NEVER sent to clients.
//
//  Voice (WebRTC) signalling for the in-match lobby is relayed here too.
// ============================================================================
const { pool } = require('../db');
const { getBalance } = require('../wallet');
const { intInRange } = require('../rng');
const lb = require('../games/liarsBar');

const SIZES = [2, 3, 4];
const TURN_MS    = 30000;   // think time per turn
const REVEAL_MS  = 3400;    // card-by-card flip reveal before the shot
const SHOT_MS    = 2400;    // bang/click beat (room for the victim's POV moment)
const NEXT_MS    = 1700;    // pause before the next round deals
const START_MS   = 1600;    // pause after match start

function attach(io) {
  const ns = io.of('/lb');
  const queues  = new Map();  // `${size}:${bet}` -> [socketId,...]
  const matches = new Map();  // matchId -> match
  const socks   = new Map();  // socketId -> { userId, username, currentMatch, lastChatAt }

  ns.use((socket, next) => {
    const userId = socket.request?.session?.userId;
    if (!userId) return next(new Error('not_authenticated'));
    socket.data.userId = userId;
    next();
  });

  ns.on('connection', async (socket) => {
    const userId = socket.data.userId;
    let username = 'player';
    try {
      const { rows } = await pool.query('SELECT COALESCE(display_name, username) AS n FROM users WHERE id=$1', [userId]);
      username = rows[0]?.n || 'player';
    } catch (_) {}
    socks.set(socket.id, { userId, username, currentMatch: null });
    socket.emit('lb_ready', {});

    socket.on('find_match', async ({ size, bet } = {}, cb) => {
      size = Number(size); bet = Math.floor(Number(bet));
      if (!SIZES.includes(size)) return cb?.({ error: 'invalid_size' });
      if (!Number.isFinite(bet) || bet < lb.MIN_BET) return cb?.({ error: 'invalid_bet' });
      const me = socks.get(socket.id);
      if (me.currentMatch) return cb?.({ error: 'already_in_match' });
      const bal = await getBalance(userId).catch(() => 0);
      if (bal < bet) return cb?.({ error: 'insufficient_balance' });

      const key = `${size}:${bet}`;
      const q = queues.get(key) || [];
      if (!q.includes(socket.id)) q.push(socket.id);
      queues.set(key, q);
      cb?.({ ok: true, waiting: q.length, needed: size });
      broadcastQueue(key, size, bet);

      if (q.length >= size) {
        const chosen = q.slice(0, size);
        queues.set(key, q.slice(size));
        await launchMatch(chosen, size, bet).catch(e => {
          for (const sid of chosen) ns.to(sid).emit('lb_error', { error: e.message || 'match_failed' });
        });
      }
    });

    socket.on('cancel_find', () => {
      for (const [key, arr] of queues) {
        const i = arr.indexOf(socket.id);
        if (i >= 0) { arr.splice(i, 1); queues.set(key, arr); const [s, b] = key.split(':'); broadcastQueue(key, +s, +b); }
      }
    });

    // Play 1-3 cards (indices into your own hand).
    socket.on('lb_play', ({ cards } = {}) => {
      const m = myMatch(socket.id); if (!m || m.finished || m.phase !== 'play') return;
      const p = m.players[m.active];
      if (!p || p.socketId !== socket.id || !p.alive) return;
      if (!Array.isArray(cards)) return;
      // Dedupe + validate indices.
      const idx = [...new Set(cards.map(Number))].filter(i => Number.isInteger(i) && i >= 0 && i < p.hand.length);
      if (idx.length < 1 || idx.length > 3) return;
      handlePlay(m, p, idx);
    });

    // Call the previous player a liar.
    socket.on('lb_liar', () => {
      const m = myMatch(socket.id); if (!m || m.finished || m.phase !== 'play') return;
      const p = m.players[m.active];
      if (!p || p.socketId !== socket.id || !p.alive) return;
      if (!m.lastPlay) return;             // nothing to call
      handleLiar(m);
    });

    socket.on('lb_chat', ({ text } = {}) => {
      const me = socks.get(socket.id); if (!me?.currentMatch) return;
      const m = matches.get(me.currentMatch); if (!m) return;
      const p = m.players.find(x => x.socketId === socket.id); if (!p) return;
      const now = Date.now();
      if (now - (me.lastChatAt || 0) < 400) return;
      me.lastChatAt = now;
      const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!t) return;
      const payload = { seat: p.seat, name: p.username, text: t };
      for (const q of m.players) ns.to(q.socketId).emit('lb_chat', payload);
    });

    // ── Voice (WebRTC) signalling relay ──────────────────────────────────────
    // The client announces it has mic on; we tell the other players its seat so
    // they can open a peer connection. Offer/answer/ICE are relayed by seat.
    socket.on('lb_voice_join', () => {
      const m = myMatch(socket.id); if (!m) return;
      const p = m.players.find(x => x.socketId === socket.id); if (!p) return;
      p.voice = true;
      for (const q of m.players) {
        if (q.socketId === socket.id) continue;
        ns.to(q.socketId).emit('lb_voice_peer', { seat: p.seat, on: true });
        // Also tell the joiner about peers already on voice.
        if (q.voice) ns.to(socket.id).emit('lb_voice_peer', { seat: q.seat, on: true });
      }
    });
    socket.on('lb_voice_leave', () => {
      const m = myMatch(socket.id); if (!m) return;
      const p = m.players.find(x => x.socketId === socket.id); if (!p) return;
      p.voice = false;
      for (const q of m.players) if (q.socketId !== socket.id) ns.to(q.socketId).emit('lb_voice_peer', { seat: p.seat, on: false });
    });
    socket.on('lb_voice_signal', ({ toSeat, data } = {}) => {
      const m = myMatch(socket.id); if (!m) return;
      const from = m.players.find(x => x.socketId === socket.id); if (!from) return;
      const to = m.players.find(x => x.seat === Number(toSeat)); if (!to) return;
      ns.to(to.socketId).emit('lb_voice_signal', { fromSeat: from.seat, data });
    });

    socket.on('disconnect', () => handleLeave(socket.id));
  });

  function myMatch(socketId) {
    const me = socks.get(socketId); if (!me?.currentMatch) return null;
    return matches.get(me.currentMatch) || null;
  }

  // ── Matchmaking ────────────────────────────────────────────────────────────
  function broadcastQueue(key, size, bet) {
    const q = queues.get(key) || [];
    for (const sid of q) ns.to(sid).emit('lb_queue', { size, bet, waiting: q.length, needed: size });
  }

  async function launchMatch(socketIds, size, bet) {
    const live = socketIds.filter(sid => socks.has(sid) && ns.sockets.get(sid));
    if (live.length < size) {
      const key = `${size}:${bet}`;
      const q = queues.get(key) || [];
      queues.set(key, [...live, ...q]);
      broadcastQueue(key, size, bet);
      return;
    }
    const userIds = live.map(sid => socks.get(sid).userId);
    const { sessionId, pot } = await lb.createMatch(userIds, bet);

    const players = live.map((sid, i) => ({
      socketId: sid, userId: socks.get(sid).userId, username: socks.get(sid).username,
      seat: i, alive: true, hand: [],
      chamber: 0, bulletAt: intInRange(0, lb.CHAMBERS - 1), pulls: 0, voice: false,
    }));
    const m = {
      id: sessionId, sessionId, bet, pot, size, userIds,
      players, tableCard: 'A', active: 0, lastPlay: null,
      reveal: null, shot: null, round: 0,
      phase: 'play', finished: false, timer: null,
    };
    matches.set(m.id, m);
    for (const p of players) socks.get(p.socketId).currentMatch = m.id;

    for (const p of players) {
      ns.to(p.socketId).emit('lb_match_start', {
        matchId: m.id, yourSeat: p.seat, bet, pot, size,
        players: players.map(x => ({ seat: x.seat, name: x.username })),
      });
    }
    setTimer(m, () => startRound(m, intInRange(0, size - 1)), START_MS);
  }

  // ── Rounds / turns ──────────────────────────────────────────────────────────
  function aliveCount(m) { return m.players.filter(p => p.alive).length; }
  function nextAlive(m, from) {
    for (let k = 1; k <= m.size; k++) { const j = (from + k) % m.size; if (m.players[j].alive) return j; }
    return from;
  }

  function startRound(m, firstSeat) {
    if (m.finished) return;
    if (aliveCount(m) <= 1) return endMatch(m);
    const deck = lb.makeDeck();
    let di = 0;
    for (const p of m.players) {
      p.hand = [];
      if (!p.alive) continue;
      for (let k = 0; k < lb.HAND_SIZE && di < deck.length; k++) p.hand.push(deck[di++]);
    }
    m.tableCard = lb.CARD_TYPES[intInRange(0, lb.CARD_TYPES.length - 1)];
    m.lastPlay = null;
    m.reveal = null;
    m.shot = null;
    m.round = (m.round || 0) + 1;
    m.phase = 'play';
    if (!m.players[firstSeat]?.alive) firstSeat = nextAlive(m, firstSeat);
    m.active = firstSeat;
    const tc = cardName(m.tableCard);
    emitState(m, { event: { text: `Round ${m.round} — the table card is ${tc}. ${m.players[m.active].username} starts.`, kind: 'deal' } });
    beginTurn(m);
  }

  function beginTurn(m) {
    if (m.finished) return;
    // Skip any dead seats defensively.
    if (!m.players[m.active]?.alive) m.active = nextAlive(m, m.active);
    m.phase = 'play';
    m.turnEndsAt = Date.now() + TURN_MS;   // clients render the countdown
    emitState(m);
    setTimer(m, () => onTurnTimeout(m), TURN_MS);
  }

  function onTurnTimeout(m) {
    if (m.finished || m.phase !== 'play') return;
    const p = m.players[m.active];
    if (!p || !p.alive) return;
    if (p.hand.length > 0) {
      // Forced: play one random card claiming the table card.
      handlePlay(m, p, [intInRange(0, p.hand.length - 1)]);
    } else if (m.lastPlay) {
      handleLiar(m);
    }
  }

  function handlePlay(m, p, idx) {
    clearTimer(m);
    // Pull the chosen cards out of the hand (high → low so splices stay valid).
    const sorted = idx.slice().sort((a, b) => b - a);
    const played = [];
    for (const i of sorted) played.push(p.hand.splice(i, 1)[0]);
    played.reverse();
    m.lastPlay = { seat: p.seat, cards: played, count: played.length };
    m.active = nextAlive(m, p.seat);
    emitState(m, { event: { text: `${p.username} plays ${played.length} card${played.length > 1 ? 's' : ''}, claiming ${cardName(m.tableCard)}.`, kind: 'play' } });
    beginTurn(m);
  }

  function handleLiar(m) {
    clearTimer(m);
    const caller = m.players[m.active];
    const lastP  = m.lastPlay;
    const bluffer = m.players[lastP.seat];
    const truthful = lastP.cards.every(c => lb.cardMatches(c, m.tableCard));
    const loserSeat = truthful ? m.active : lastP.seat;
    m.phase = 'reveal';
    m.reveal = {
      callerSeat: caller.seat, callerName: caller.username,
      blufferSeat: bluffer.seat, blufferName: bluffer.username,
      cards: lastP.cards, tableCard: m.tableCard,
      truthful, loserSeat, loserName: m.players[loserSeat].username,
    };
    const verdict = truthful
      ? `${caller.username} calls LIAR — but ${bluffer.username} was honest! ${caller.username} pulls the trigger…`
      : `${caller.username} calls LIAR — and ${bluffer.username} was bluffing! ${bluffer.username} pulls the trigger…`;
    emitState(m, { event: { text: verdict, kind: truthful ? 'truth' : 'lie' } });
    setTimer(m, () => doTrigger(m, loserSeat), REVEAL_MS);
  }

  function doTrigger(m, victimSeat) {
    if (m.finished) return;
    const v = m.players[victimSeat];
    const fired = (v.chamber === v.bulletAt);
    v.pulls = (v.pulls || 0) + 1;
    let ev;
    if (fired) {
      v.alive = false;
      ev = { text: `💥 BANG — ${v.username} is eliminated!`, kind: 'bang' };
    } else {
      v.chamber += 1;   // advance the cylinder → next pull is deadlier
      ev = { text: `*click* — ${v.username} survives. (${lb.CHAMBERS - v.chamber} safe chamber${lb.CHAMBERS - v.chamber === 1 ? '' : 's'} left)`, kind: 'safe' };
    }
    m.phase = 'shoot';
    m.shot = { seat: victimSeat, fired };
    emitState(m, { event: ev, shot: { seat: victimSeat, fired } });
    setTimer(m, () => afterShot(m, victimSeat, fired), SHOT_MS);
  }

  function afterShot(m, victimSeat, fired) {
    if (m.finished) return;
    if (aliveCount(m) <= 1) return endMatch(m);
    const v = m.players[victimSeat];
    const starter = v.alive ? victimSeat : nextAlive(m, victimSeat);
    setTimer(m, () => startRound(m, starter), NEXT_MS);
  }

  // ── State broadcast (per-socket: only YOUR hand; bullet never sent) ─────────
  function buildBase(m, extra) {
    return {
      phase: m.phase, round: m.round, pot: m.pot, bet: m.bet, size: m.size,
      turnEndsAt: m.phase === 'play' ? (m.turnEndsAt || 0) : 0,
      serverNow: Date.now(),
      tableCard: m.tableCard, active: m.active,
      activeName: m.players[m.active]?.username || '',
      players: m.players.map(p => ({
        seat: p.seat, name: p.username, alive: p.alive,
        handCount: p.hand.length, pulls: p.pulls || 0,
        safeLeft: Math.max(0, lb.CHAMBERS - p.chamber), voice: !!p.voice,
      })),
      lastPlay: m.lastPlay ? { seat: m.lastPlay.seat, count: m.lastPlay.count } : null,
      reveal: m.phase === 'reveal' || m.phase === 'shoot' ? m.reveal : null,
      shot: m.shot,
      ...extra,
    };
  }
  function emitState(m, extra = {}) {
    for (const p of m.players) {
      const base = buildBase(m, extra);
      base.yourSeat = p.seat;
      base.yourHand = p.hand.slice();
      base.canPlay  = (m.phase === 'play' && m.active === p.seat && p.alive && p.hand.length > 0);
      base.canCall  = (m.phase === 'play' && m.active === p.seat && p.alive && !!m.lastPlay);
      ns.to(p.socketId).emit('lb_state', base);
    }
  }

  // ── End / cleanup ────────────────────────────────────────────────────────────
  function endMatch(m) {
    if (m.finished) return;
    m.finished = true; m.phase = 'over';
    clearTimer(m);
    const alive = m.players.filter(p => p.alive);
    const winner = alive.length === 1 ? alive[0] : null;
    lb.finishMatch(m.sessionId, winner ? winner.userId : null, m.pot)
      .catch(e => console.error('[lb] finishMatch', e.message))
      .finally(async () => {
        for (const p of m.players) {
          const bal = await getBalance(p.userId).catch(() => null);
          ns.to(p.socketId).emit('lb_match_end', {
            winnerSeat: winner ? winner.seat : null,
            winnerName: winner ? winner.username : null,
            youWon: winner ? winner.userId === p.userId : false,
            pot: m.pot, newBalance: bal,
          });
        }
        cleanup(m);
      });
  }

  function cleanup(m) {
    for (const p of m.players) { const s = socks.get(p.socketId); if (s) s.currentMatch = null; }
    matches.delete(m.id);
  }
  function setTimer(m, fn, ms) { clearTimer(m); m.timer = setTimeout(() => { m.timer = null; try { fn(); } catch (e) { console.error('[lb] timer', e.message); } }, ms); }
  function clearTimer(m) { if (m.timer) { clearTimeout(m.timer); m.timer = null; } }

  function handleLeave(socketId) {
    for (const [key, arr] of queues) {
      const i = arr.indexOf(socketId);
      if (i >= 0) { arr.splice(i, 1); queues.set(key, arr); const [s, b] = key.split(':'); broadcastQueue(key, +s, +b); }
    }
    const me = socks.get(socketId);
    if (me?.currentMatch) {
      const m = matches.get(me.currentMatch);
      if (m && !m.finished) {
        const p = m.players.find(x => x.socketId === socketId);
        if (p && p.alive) {
          p.alive = false;
          // Let voice peers tear the connection down.
          for (const q of m.players) if (q.socketId !== socketId) ns.to(q.socketId).emit('lb_voice_peer', { seat: p.seat, on: false });
          emitState(m, { event: { text: `${p.username} left — forfeits.`, kind: 'lie' } });
          if (aliveCount(m) <= 1) endMatch(m);
          else if (m.phase === 'play' && m.active === p.seat) { clearTimer(m); setTimer(m, () => startRound(m, nextAlive(m, p.seat)), 800); }
        }
      }
    }
    socks.delete(socketId);
  }

  function cardName(t) { return t === 'A' ? 'ACE' : t === 'K' ? 'KING' : t === 'Q' ? 'QUEEN' : 'JOKER'; }
}

module.exports = { attach };
