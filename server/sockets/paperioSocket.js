// server/sockets/paperioSocket.js
// ============================================================================
//  /paperio namespace — real multiplayer Paper.io-style territory game.
//
//  Matchmaking queues by (lobbySize, bet). When `size` players are queued a
//  match starts: every ante is escrowed, players spawn apart each owning a
//  3x3 box of their colour, and a server tick loop advances everyone one grid
//  cell per tick. Leaving your territory draws a trail; returning closes the
//  loop and captures the enclosed area (border flood-fill). Crossing another
//  player's trail eliminates them; crossing your own trail or hitting the wall
//  eliminates you. Game ends when one player remains (takes the pot minus the
//  house fee) or when the timer runs out (survivors split the pot by territory
//  size, house still takes its fee).
//
//  Server-authoritative: clients only send a desired direction.
// ============================================================================
const { pool } = require('../db');
const { getBalance } = require('../wallet');
const { intInRange } = require('../rng');
const paperio = require('../games/paperio');

const W = 48, H = 48;                 // grid size
const TICK_MS = 120;                  // movement cadence
const DURATION_MS = 150000;           // 2.5 min round
const SIZES = [2, 3, 4, 5, 6];
// Strong, vibrant, well-separated hues.
const COLORS = ['#ff2d55', '#00d4ff', '#1fff6a', '#b15bff', '#ffd400', '#ff7a00'];
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];   // 0=up 1=right 2=down 3=left

function attach(io) {
  const ns = io.of('/paperio');
  const queues  = new Map();   // `${size}:${bet}` -> [socketId]
  const matches = new Map();   // matchId -> match
  const socks   = new Map();   // socketId -> { userId, username, currentMatch }

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
    socket.emit('pp_ready', {});

    socket.on('find_match', async ({ size, bet } = {}, cb) => {
      size = Number(size); bet = Math.floor(Number(bet));
      if (!SIZES.includes(size)) return cb?.({ error: 'invalid_size' });
      if (!Number.isFinite(bet) || bet < paperio.MIN_BET) return cb?.({ error: 'invalid_bet' });
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
        await launch(chosen, size, bet).catch(e => {
          for (const sid of chosen) ns.to(sid).emit('pp_error', { error: e.message || 'match_failed' });
        });
      }
    });

    socket.on('cancel_find', () => {
      for (const [key, arr] of queues) {
        const i = arr.indexOf(socket.id);
        if (i >= 0) { arr.splice(i, 1); queues.set(key, arr); const [s, b] = key.split(':'); broadcastQueue(key, +s, +b); }
      }
    });

    socket.on('pp_dir', ({ dir } = {}) => {
      dir = Number(dir);
      if (![0, 1, 2, 3].includes(dir)) return;
      const me = socks.get(socket.id); if (!me?.currentMatch) return;
      const m = matches.get(me.currentMatch); if (!m || m.over) return;
      const p = m.players.find(x => x.socketId === socket.id);
      if (!p || !p.alive) return;
      // No instant 180° reverse.
      if ((dir + 2) % 4 === p.dir) return;
      p.pendingDir = dir;
    });

    socket.on('disconnect', () => handleLeave(socket.id));
  });

  function broadcastQueue(key, size, bet) {
    const q = queues.get(key) || [];
    for (const sid of q) ns.to(sid).emit('pp_queue', { size, bet, waiting: q.length, needed: size });
  }

  // ── Launch + spawn ─────────────────────────────────────────────────────────
  async function launch(socketIds, size, bet) {
    const live = socketIds.filter(sid => socks.has(sid) && ns.sockets.get(sid));
    if (live.length < size) {
      const key = `${size}:${bet}`; const q = queues.get(key) || [];
      queues.set(key, [...live, ...q]); broadcastQueue(key, size, bet); return;
    }
    const userIds = live.map(sid => socks.get(sid).userId);
    const { sessionId, pot, feePct } = await paperio.createMatch(userIds, bet);

    const owner = new Int8Array(W * H).fill(-1);
    const trail = new Int8Array(W * H).fill(-1);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.32;
    const players = live.map((sid, i) => {
      const ang = (i / size) * Math.PI * 2 - Math.PI / 2;
      const px = Math.max(2, Math.min(W - 3, Math.round(cx + Math.cos(ang) * R)));
      const py = Math.max(2, Math.min(H - 3, Math.round(cy + Math.sin(ang) * R)));
      const p = {
        socketId: sid, userId: socks.get(sid).userId, username: socks.get(sid).username,
        idx: i, color: COLORS[i % COLORS.length], alive: true,
        x: px, y: py, dir: i % 4, pendingDir: i % 4, trail: [], area: 0,
      };
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const c = (py + dy) * W + (px + dx); owner[c] = i;
      }
      p.area = 9;
      return p;
    });

    const m = {
      id: sessionId, sessionId, bet, pot, feePct, size, userIds,
      owner, trail, players, over: false, gridDirty: true,
      endsAt: Date.now() + DURATION_MS, timer: null,
    };
    matches.set(m.id, m);
    for (const p of players) socks.get(p.socketId).currentMatch = m.id;

    for (const p of players) {
      ns.to(p.socketId).emit('pp_start', {
        w: W, h: H, yourIdx: p.idx, bet, pot, feePct, durationMs: DURATION_MS,
        players: players.map(x => ({ idx: x.idx, name: x.username, color: x.color })),
      });
    }
    sendGrid(m); sendTick(m);
    m.timer = setInterval(() => tick(m), TICK_MS);
  }

  // ── Tick ─────────────────────────────────────────────────────────────────
  function tick(m) {
    if (m.over) return;
    if (Date.now() >= m.endsAt) return endByTimer(m);
    for (const p of m.players) {
      if (!p.alive) continue;
      if ((p.pendingDir + 2) % 4 !== p.dir) p.dir = p.pendingDir;
      const nx = p.x + DX[p.dir], ny = p.y + DY[p.dir];
      // Walls are solid, NOT lethal — the player just can't move past the edge
      // and stays put this tick (they can still turn away).
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const nc = ny * W + nx;
      const tOwn = m.trail[nc];
      if (tOwn === p.idx) {
        // Crossing your OWN trail closes the loop and CAPTURES the enclosed
        // area — this is the deliberate way to carve out / steal territory.
        // It is NOT lethal. (Only a rival's trail or a head-on ram kills you.)
        p.x = nx; p.y = ny;
        capture(m, p);
        continue;
      }
      if (tOwn !== -1) {
        // Crossing another player's trail cuts them down.
        killPlayer(m, m.players[tOwn], `cut by ${p.username}`);
      }
      // body collision: stepping onto another live player's head
      const onHead = m.players.find(q => q.alive && q.idx !== p.idx && q.x === nx && q.y === ny);
      if (onHead) { killPlayer(m, onHead, `rammed by ${p.username}`); }
      p.x = nx; p.y = ny;
      if (m.owner[nc] === p.idx) {
        if (p.trail.length) capture(m, p);
      } else {
        m.trail[nc] = p.idx; p.trail.push(nc);
      }
    }
    const alive = m.players.filter(p => p.alive);
    if (alive.length <= 1) return endByLast(m, alive[0] || leader(m));
    sendTick(m);
    if (m.gridDirty) { sendGrid(m); m.gridDirty = false; }
  }

  function killPlayer(m, p, reason) {
    if (!p.alive) return;
    p.alive = false;
    for (const c of p.trail) if (m.trail[c] === p.idx) m.trail[c] = -1;
    for (let c = 0; c < m.owner.length; c++) if (m.owner[c] === p.idx) m.owner[c] = -1;
    p.trail = []; p.area = 0; m.gridDirty = true;
    emitEvent(m, `💀 ${p.username} ${reason}.`);
  }

  // Close the loop: trail + enclosed pockets become the player's territory.
  function capture(m, p) {
    for (const c of p.trail) { m.owner[c] = p.idx; m.trail[c] = -1; }
    p.trail = [];
    // Flood fill from the borders across every cell NOT owned by p. Anything
    // unreached is enclosed -> claim it.
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x); stack.push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W); stack.push(y * W + (W - 1)); }
    while (stack.length) {
      const c = stack.pop();
      if (c < 0 || c >= W * H || seen[c] || m.owner[c] === p.idx) continue;
      seen[c] = 1;
      const x = c % W, y = (c / W) | 0;
      if (x > 0)     stack.push(c - 1);
      if (x < W - 1) stack.push(c + 1);
      if (y > 0)     stack.push(c - W);
      if (y < H - 1) stack.push(c + W);
    }
    for (let c = 0; c < m.owner.length; c++) {
      if (m.owner[c] !== p.idx && !seen[c]) { m.owner[c] = p.idx; if (m.trail[c] !== -1) m.trail[c] = -1; }
    }
    // Reconcile any trail arrays the capture overwrote.
    for (const q of m.players) {
      if (q !== p) q.trail = q.trail.filter(c => m.trail[c] === q.idx);
    }
    // Recompute EVERY player's area in a single pass — a capture can take
    // cells from a rival, so that rival's territory (and their leaderboard
    // percentage) has to drop accordingly, not just the capturer's go up.
    for (const q of m.players) q.area = 0;
    for (let c = 0; c < m.owner.length; c++) { const o = m.owner[c]; if (o >= 0) m.players[o].area++; }
    m.gridDirty = true;
    emitEvent(m, `🟦 ${p.username} captured territory (${p.area}).`);
  }

  function leader(m) {
    return m.players.slice().sort((a, b) => b.area - a.area)[0];
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────
  function sendGrid(m) {
    const owner = Array.from(m.owner);
    for (const p of m.players) ns.to(p.socketId).emit('pp_grid', { owner });
  }
  function sendTick(m) {
    const payload = {
      timeLeft: Math.max(0, m.endsAt - Date.now()),
      players: m.players.map(p => ({ idx: p.idx, x: p.x, y: p.y, dir: p.dir, alive: p.alive, area: p.area })),
      trails: m.players.map(p => p.trail),
    };
    for (const p of m.players) ns.to(p.socketId).emit('pp_tick', payload);
  }
  function emitEvent(m, text) { for (const p of m.players) ns.to(p.socketId).emit('pp_event', { text }); }

  // ── End / payout ───────────────────────────────────────────────────────────
  function computePayouts(m, winner) {
    const payPool = Math.floor(m.pot * (1 - m.feePct / 100));
    if (winner) return [{ userId: winner.userId, idx: winner.idx, name: winner.username, credits: payPool }];
    const survivors = m.players.filter(p => p.alive);
    const tot = survivors.reduce((s, p) => s + p.area, 0);
    if (tot <= 0) { const w = leader(m); return [{ userId: w.userId, idx: w.idx, name: w.username, credits: payPool }]; }
    return survivors.map(p => ({ userId: p.userId, idx: p.idx, name: p.username, credits: Math.floor(payPool * p.area / tot) }));
  }
  function endByLast(m, winner) { finalize(m, computePayouts(m, winner), winner ? winner.idx : null, 'last_standing'); }
  function endByTimer(m)        { finalize(m, computePayouts(m, null), null, 'time'); }

  function finalize(m, payouts, winnerIdx, reason) {
    if (m.over) return;
    m.over = true;
    if (m.timer) { clearInterval(m.timer); m.timer = null; }
    paperio.finishMatch(m.sessionId, payouts.map(p => ({ userId: p.userId, credits: p.credits })))
      .catch(e => console.error('[paperio] finishMatch', e.message))
      .finally(async () => {
        const byUser = {}; for (const p of payouts) byUser[p.userId] = p.credits;
        for (const p of m.players) {
          const bal = await getBalance(p.userId).catch(() => null);
          ns.to(p.socketId).emit('pp_end', {
            reason, winnerIdx, pot: m.pot,
            payouts: payouts.map(x => ({ idx: x.idx, name: x.name, credits: x.credits })),
            youCredits: byUser[p.userId] || 0, newBalance: bal,
          });
        }
        cleanup(m);
      });
  }
  function cleanup(m) {
    for (const p of m.players) { const s = socks.get(p.socketId); if (s) s.currentMatch = null; }
    matches.delete(m.id);
  }

  function handleLeave(socketId) {
    for (const [key, arr] of queues) {
      const i = arr.indexOf(socketId);
      if (i >= 0) { arr.splice(i, 1); queues.set(key, arr); const [s, b] = key.split(':'); broadcastQueue(key, +s, +b); }
    }
    const me = socks.get(socketId);
    if (me?.currentMatch) {
      const m = matches.get(me.currentMatch);
      if (m && !m.over) {
        const p = m.players.find(x => x.socketId === socketId);
        if (p && p.alive) {
          killPlayer(m, p, 'disconnected');
          const alive = m.players.filter(x => x.alive);
          if (alive.length <= 1) endByLast(m, alive[0] || leader(m));
          else { sendTick(m); sendGrid(m); m.gridDirty = false; }
        }
      }
    }
    socks.delete(socketId);
  }
}

module.exports = { attach };
