// server/sockets/rrSocket.js
// ============================================================================
//  /rr namespace — real player-vs-player "Russian Roulette".
//
//  Matchmaking queues by (lobbySize, bet). When `size` players are queued at
//  the same bet a match starts: every ante is escrowed, then the server runs
//  the whole turn loop (deal a blackjack hand to the active player, they act,
//  the dealer plays, the result decides the trigger pull) until one player
//  remains and takes the pot. Everything money/ random is server-authoritative
//  — clients only send their action choices.
// ============================================================================
const { pool } = require('../db');
const { getBalance } = require('../wallet');
const { intInRange } = require('../rng');
const rr = require('../games/rouletteRoyale');

const SIZES = [2, 3, 4];
const ACTION_TIMEOUT_MS = 22000;   // auto-stand if the active player stalls
const TARGET_TIMEOUT_MS = 15000;   // auto-pick a target on a blackjack
const DEAL_MS   = 850;
const DEALER_MS = 750;
const SHOT_MS   = 1500;
const NEXT_MS   = 1300;
const MAX_ROUNDS = 30;

function attach(io) {
  const ns = io.of('/rr');
  const queues  = new Map();  // `${size}:${bet}` -> [socketId,...]
  const matches = new Map();  // matchId -> match
  const socks   = new Map();  // socketId -> { userId, username, currentMatch }

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
    socket.emit('rr_ready', {});

    socket.on('find_match', async ({ size, bet } = {}, cb) => {
      size = Number(size); bet = Math.floor(Number(bet));
      if (!SIZES.includes(size)) return cb?.({ error: 'invalid_size' });
      if (!Number.isFinite(bet) || bet < rr.MIN_BET) return cb?.({ error: 'invalid_bet' });
      const me = socks.get(socket.id);
      if (me.currentMatch) return cb?.({ error: 'already_in_match' });
      const bal = await getBalance(userId).catch(() => 0);
      if (bal < bet) return cb?.({ error: 'insufficient_balance' });

      const key = `${size}:${bet}`;
      const q = queues.get(key) || [];
      // de-dupe + drop the same user on other sockets
      if (!q.includes(socket.id)) q.push(socket.id);
      queues.set(key, q);
      cb?.({ ok: true, waiting: q.length, needed: size });
      broadcastQueue(key, size, bet);

      if (q.length >= size) {
        const chosen = q.slice(0, size);
        queues.set(key, q.slice(size));
        await launchMatch(chosen, size, bet).catch(e => {
          for (const sid of chosen) ns.to(sid).emit('rr_error', { error: e.message || 'match_failed' });
        });
      }
    });

    socket.on('cancel_find', () => {
      for (const [key, arr] of queues) {
        const i = arr.indexOf(socket.id);
        if (i >= 0) { arr.splice(i, 1); queues.set(key, arr); const [s,b]=key.split(':'); broadcastQueue(key, +s, +b); }
      }
    });

    socket.on('rr_action', ({ action } = {}) => {
      const me = socks.get(socket.id); if (!me?.currentMatch) return;
      const m = matches.get(me.currentMatch); if (!m || m.finished) return;
      if (m.phase !== 'turn') return;
      const p = m.players[m.active];
      if (!p || p.socketId !== socket.id || !p.alive) return;
      if (!['hit', 'stand', 'double'].includes(action)) return;
      handleAction(m, action);
    });

    socket.on('rr_target', ({ seat } = {}) => {
      const me = socks.get(socket.id); if (!me?.currentMatch) return;
      const m = matches.get(me.currentMatch); if (!m || m.finished) return;
      if (m.phase !== 'targeting' || m.shooter == null) return;
      if (m.players[m.shooter].socketId !== socket.id) return;
      const t = m.players[seat];
      if (!t || !t.alive || seat === m.shooter) return;
      clearTimer(m);
      doTrigger(m, seat, () => afterBlackjackShot(m));
    });

    socket.on('disconnect', () => handleLeave(socket.id));
  });

  // ── Matchmaking helpers ──────────────────────────────────────────────────
  function broadcastQueue(key, size, bet) {
    const q = queues.get(key) || [];
    for (const sid of q) ns.to(sid).emit('rr_queue', { size, bet, waiting: q.length, needed: size });
  }

  async function launchMatch(socketIds, size, bet) {
    // Filter to still-connected sockets.
    const live = socketIds.filter(sid => socks.has(sid) && ns.sockets.get(sid));
    if (live.length < size) {                       // someone vanished — requeue the rest
      const key = `${size}:${bet}`;
      const q = queues.get(key) || [];
      queues.set(key, [...live, ...q]);
      broadcastQueue(key, size, bet);
      return;
    }
    const userIds = live.map(sid => socks.get(sid).userId);
    const { sessionId, pot } = await rr.createMatch(userIds, bet);

    const players = live.map((sid, i) => ({
      socketId: sid, userId: socks.get(sid).userId, username: socks.get(sid).username,
      seat: i, alive: true, cards: [],
    }));
    const m = {
      id: sessionId, sessionId, bet, pot, size, userIds,
      players, dealer: [], dealerDone: false,
      chamber: 1, bullet: intInRange(1, 6), round: 1,
      active: intInRange(0, size - 1), shooter: null,
      phase: 'turn', finished: false, timer: null,
    };
    matches.set(m.id, m);
    for (const p of players) socks.get(p.socketId).currentMatch = m.id;

    for (const p of players) {
      ns.to(p.socketId).emit('rr_match_start', {
        matchId: m.id, yourSeat: p.seat, bet, pot, size,
        players: players.map(x => ({ seat: x.seat, name: x.username })),
      });
    }
    emitState(m, { event: { text: `Game on — pot ${pot} cr. The revolver starts on ${players[m.active].username}.`, kind: 'deal' } });
    setTimer(m, () => startTurn(m, m.active), 1500);
  }

  // ── State broadcast (per-socket: hides the bullet, flags your seat) ───────
  function buildBase(m, extra) {
    const active = m.players[m.active];
    return {
      phase: m.phase, active: m.active, chamber: m.chamber, round: m.round, maxRounds: MAX_ROUNDS,
      pot: m.pot, bet: m.bet, size: m.size,
      players: m.players.map(p => ({ seat: p.seat, name: p.username, alive: p.alive })),
      activeCards: active ? active.cards : [],
      activeName: active ? active.username : '',
      activeValue: active ? rr.handValue(active.cards) : 0,
      dealer: m.dealer.map(c => c.hidden && !m.dealerDone ? { hidden: true } : c),
      dealerValue: m.dealerDone ? rr.handValue(m.dealer) : rr.handValue(m.dealer.filter(c => !c.hidden)),
      dealerDone: m.dealerDone,
      ...extra,
    };
  }
  function emitState(m, extra = {}) {
    for (const p of m.players) {
      const base = buildBase(m, extra);
      base.yourSeat = p.seat;
      base.canAct = (m.phase === 'turn' && m.active === p.seat && p.alive);
      base.canTarget = (m.phase === 'targeting' && m.shooter === p.seat && p.alive);
      if (base.canTarget) base.targets = m.players.filter(x => x.alive && x.seat !== p.seat).map(x => x.seat);
      ns.to(p.socketId).emit('rr_state', base);
    }
  }

  // ── Turn flow ────────────────────────────────────────────────────────────
  function aliveCount(m) { return m.players.filter(p => p.alive).length; }
  function nextAlive(m, from) {
    for (let k = 1; k <= m.size; k++) { const j = (from + k) % m.size; if (m.players[j].alive) return j; }
    return from;
  }

  function startTurn(m, seat) {
    if (m.finished) return;
    if (aliveCount(m) <= 1) return endMatch(m);
    if (m.round > MAX_ROUNDS) return endMatch(m);
    if (!m.players[seat].alive) return startTurn(m, nextAlive(m, seat));
    m.active = seat; m.shooter = null; m.dealerDone = false;
    const p = m.players[seat];
    p.cards = [rr.drawCard(), rr.drawCard()];
    m.dealer = [rr.drawCard(), { ...rr.drawCard(), hidden: true }];

    if (rr.isBlackjack(p.cards)) {
      m.phase = 'targeting';
      m.dealerDone = true;
      emitState(m, { event: { text: `🂡 ${p.username} hits BLACKJACK — they get to take a shot!`, kind: 'bj' } });
      setTimer(m, () => {                          // auto-pick if they stall
        const opp = m.players.filter(x => x.alive && x.seat !== seat).map(x => x.seat);
        if (opp.length) doTrigger(m, opp[intInRange(0, opp.length - 1)], () => afterBlackjackShot(m));
        else startTurn(m, nextAlive(m, seat));
      }, TARGET_TIMEOUT_MS);
      return;
    }
    m.phase = 'turn';
    emitState(m, { event: { text: `${p.username} is dealt a hand.`, kind: 'deal' } });
    setTimer(m, () => handleAction(m, 'stand'), ACTION_TIMEOUT_MS);  // auto-stand on timeout
  }

  function handleAction(m, action) {
    if (m.phase !== 'turn') return;
    clearTimer(m);
    const p = m.players[m.active];
    if (action === 'hit' || action === 'double') {
      p.cards.push(rr.drawCard());
      const bust = rr.handValue(p.cards) > 21;
      if (action === 'hit' && !bust) {
        emitState(m, { event: { text: `${p.username} hits (${rr.handValue(p.cards)}).`, kind: 'deal' } });
        setTimer(m, () => handleAction(m, 'stand'), ACTION_TIMEOUT_MS);
        return;
      }
      // Committed (double or bust) — lock the turn so no extra action lands.
      m.phase = 'resolving';
      emitState(m, { event: { text: action === 'double' ? `${p.username} doubles down.` : `${p.username} hits and busts!`, kind: 'deal' } });
      return setTimer(m, () => playDealer(m), 600);
    }
    // stand — lock the turn immediately (was still 'turn' during the short
    // pre-dealer delay, which let a fast player sneak another hit/stand in).
    m.phase = 'resolving';
    emitState(m, { event: { text: `${p.username} stands (${rr.handValue(p.cards)}).`, kind: 'deal' } });
    setTimer(m, () => playDealer(m), 500);
  }

  function playDealer(m) {
    m.phase = 'dealer'; m.dealerDone = true;
    if (m.dealer[1]) m.dealer[1].hidden = false;
    const p = m.players[m.active];
    const step = () => {
      if (rr.handValue(p.cards) <= 21 && rr.handValue(m.dealer) < 17) {
        m.dealer.push(rr.drawCard());
        emitState(m, { event: { text: `Dealer draws (${rr.handValue(m.dealer)}).`, kind: 'deal' } });
        return setTimer(m, step, DEALER_MS);
      }
      resolveOutcome(m);
    };
    emitState(m);
    setTimer(m, step, DEALER_MS);
  }

  function resolveOutcome(m) {
    const p = m.players[m.active];
    const pv = rr.handValue(p.cards), dv = rr.handValue(m.dealer);
    let outcome;
    if (pv > 21) outcome = 'lose';
    else if (dv > 21 || pv > dv) outcome = 'win';
    else if (pv < dv) outcome = 'lose';
    else outcome = 'push';

    if (outcome === 'push') {
      emitState(m, { event: { text: `${p.username} pushes — a new hand is dealt.`, kind: 'deal' } });
      return setTimer(m, () => startTurn(m, m.active), NEXT_MS);
    }
    if (outcome === 'win') {
      m.phase = 'resolving';
      emitState(m, { event: { text: `${p.username} beats the dealer — no trigger. Turn passes.`, kind: 'win' } });
      advanceRound(m);
      return setTimer(m, () => startTurn(m, nextAlive(m, m.active)), NEXT_MS);
    }
    // lose → pull on self
    m.phase = 'resolving';
    emitState(m, { event: { text: `${p.username} loses (${pv} vs ${dv}) — pulling the trigger…`, kind: 'lose' } });
    const seat = m.active;
    setTimer(m, () => doTrigger(m, seat, () => {
      advanceRound(m);
      if (aliveCount(m) <= 1) return endMatch(m);
      startTurn(m, nextAlive(m, seat));
    }), 900);
  }

  function afterBlackjackShot(m) {
    const shooterSeat = m.active;
    advanceRound(m);
    if (aliveCount(m) <= 1) return endMatch(m);
    startTurn(m, nextAlive(m, shooterSeat));
  }

  // Pull the trigger on victimSeat; emit the shot; schedule onDone after SHOT_MS.
  function doTrigger(m, victimSeat, onDone) {
    const victim = m.players[victimSeat];
    const fired = m.chamber === m.bullet;
    let ev;
    if (fired) {
      victim.alive = false;
      ev = { text: `💥 BANG — ${victim.username} is eliminated!`, kind: 'bang' };
      m.bullet = intInRange(1, 6); m.chamber = 1;   // bullet spent → fresh cylinder
    } else {
      ev = { text: `*click* — ${victim.username} survives.`, kind: 'safe' };
      m.chamber = m.chamber % 6 + 1;
    }
    m.phase = 'resolving';
    emitState(m, { event: ev, shot: { seat: victimSeat, fired } });
    setTimer(m, () => onDone(fired), SHOT_MS);
  }

  function advanceRound(m) { m.round = Math.min(MAX_ROUNDS, m.round + 1); }

  function endMatch(m) {
    if (m.finished) return;
    m.finished = true; m.phase = 'over';
    clearTimer(m);
    const alive = m.players.filter(p => p.alive);
    const winner = alive.length === 1 ? alive[0] : null;
    rr.finishMatch(m.sessionId, winner ? winner.userId : null, m.pot)
      .catch(e => console.error('[rr] finishMatch', e.message))
      .finally(async () => {
        for (const p of m.players) {
          const bal = await getBalance(p.userId).catch(() => null);
          ns.to(p.socketId).emit('rr_match_end', {
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
  function setTimer(m, fn, ms) { clearTimer(m); m.timer = setTimeout(() => { m.timer = null; try { fn(); } catch (e) { console.error('[rr] timer', e.message); } }, ms); }
  function clearTimer(m) { if (m.timer) { clearTimeout(m.timer); m.timer = null; } }

  async function handleLeave(socketId) {
    // remove from any queue
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
          emitState(m, { event: { text: `${p.username} left — forfeits.`, kind: 'lose' } });
          if (aliveCount(m) <= 1) { endMatch(m); }
          else if (m.active === p.seat) { clearTimer(m); setTimer(m, () => startTurn(m, nextAlive(m, p.seat)), 800); }
        }
      }
    }
    socks.delete(socketId);
  }
}

module.exports = { attach };
