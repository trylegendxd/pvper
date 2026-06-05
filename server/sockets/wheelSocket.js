// server/sockets/wheelSocket.js
// ============================================================================
//  /wheel namespace — drives the global wheel game loop and pushes state
//  updates to every connected viewer.
//
//  Loop runs server-side regardless of who is watching. A single
//  setTimeout chain advances betting → spinning → result → next round.
//
//  Events to client:
//    wheel_state          — full snapshot (phase, totals, history, layout, server time)
//    wheel_bet_update     — incremental total update after every bet
//    wheel_spin_start     — fires once when the spin begins (carries the
//                           winning segment so the client can compute the
//                           final wheel rotation)
//    wheel_result         — fires when settlement finishes
//    wheel_balance        — sent to a single user after a bet or payout
//
//  Events from client:
//    wheel_bet            — { color, amount } place a bet
// ============================================================================
const wheel = require('../games/wheel');
const { getBalance } = require('../wallet');
const { pool } = require('../db');

let _ioRef = null;
let _loopTimer = null;

function ns() { return _ioRef.of('/wheel'); }

function broadcastState() {
  ns().emit('wheel_state', wheel.snapshot());
}

// Per-user state push — used when their own bet / payout changes their
// balance or personal bet view. Cheaper than sending the whole snapshot.
async function pushUserState(userId, socketId) {
  if (!_ioRef || !userId) return;
  try {
    const balance = await getBalance(userId);
    const payload = {
      balance,
      mine: wheel.userBetSnapshot(userId),
    };
    if (socketId) ns().to(socketId).emit('wheel_balance', payload);
    // Also fan-out to every other socket the same user has open.
    for (const [sid, sock] of ns().sockets) {
      if (sid === socketId) continue;
      if (sock.data?.userId === userId) sock.emit('wheel_balance', payload);
    }
  } catch (_) {}
}

// ── Main loop ────────────────────────────────────────────────────────────
async function startBettingPhase() {
  await wheel.openBettingRound();
  broadcastState();
  _loopTimer = setTimeout(startSpinPhase, wheel.PHASE_MS.betting);
}

function startSpinPhase() {
  const params = wheel.beginSpin();
  // Ship both a full state and a dedicated wheel_spin_start with the
  // winning segment + seed so clients can animate the wheel rotating to
  // the right angle independently of the next state broadcast.
  broadcastState();
  ns().emit('wheel_spin_start', {
    segment: params.segment,
    color: params.color,
    multiplier: params.multiplier,
    phaseEndsAt: wheel.state.phaseEndsAt,
    serverNow: Date.now(),
  });
  _loopTimer = setTimeout(startResultPhase, wheel.PHASE_MS.spinning);
}

async function startResultPhase() {
  await wheel.settleSpin();
  broadcastState();
  ns().emit('wheel_result', {
    roundId: wheel.state.roundId,
    color: wheel.state.result.color,
    multiplier: wheel.state.result.multiplier,
    segment: wheel.state.result.segment,
    totals: { ...wheel.state.totals },
    history: wheel.state.history.slice(0, 12),
  });

  // Push fresh balance to every user that had a bet this round so their
  // wallet display updates without a full reload. We do this AFTER the
  // payouts hit the DB inside settleSpin().
  const payouts = wheel.state.result?.payouts || [];
  for (const p of payouts) {
    pushUserState(p.userId).catch(() => {});
  }

  _loopTimer = setTimeout(() => { startBettingPhase().catch(e => {
    console.error('[wheel] new round failed', e.message);
    _loopTimer = setTimeout(() => { startBettingPhase().catch(()=>{}); }, 5000);
  }); }, wheel.PHASE_MS.result);
}

// Hot-start the loop. If the process restarts mid-round the in-memory
// state is empty — open a fresh betting round and let the world catch
// up via the next broadcast.
async function startLoop() {
  // Hydrate the history strip from the DB so a fresh boot doesn't show
  // an empty history.
  try { wheel.state.history = await wheel.recentHistory(20); } catch (_) {}
  startBettingPhase().catch(e => {
    console.error('[wheel] initial round failed', e.message);
    _loopTimer = setTimeout(() => startLoop().catch(()=>{}), 5000);
  });
}

// ── Socket attach ────────────────────────────────────────────────────────
function attach(io) {
  _ioRef = io;
  const ns = io.of('/wheel');
  ns.use((socket, next) => {
    const req = socket.request;
    const userId = req?.session?.userId;
    if (!userId) return next(new Error('not_authenticated'));
    socket.data.userId = userId;
    next();
  });

  ns.on('connection', socket => {
    // Initial state push so a fresh page join sees the current phase /
    // totals / history immediately.
    socket.emit('wheel_state', wheel.snapshot());
    pushUserState(socket.data.userId, socket.id).catch(() => {});

    socket.on('wheel_bet', async ({ color, amount } = {}, cb) => {
      try {
        const result = await wheel.placeBet(socket.data.userId, color, amount);
        cb?.({ ok: true, balance: result.balance, totals: result.totals, mine: result.mine });
        // Update everyone's totals AND this user's per-color stake.
        io.of('/wheel').emit('wheel_bet_update', {
          totals: result.totals,
          phaseEndsAt: wheel.state.phaseEndsAt,
        });
        pushUserState(socket.data.userId, socket.id).catch(() => {});
      } catch (e) {
        cb?.({ error: e.message || 'bet_failed' });
      }
    });

    socket.on('wheel_undo_last', async (_unused, cb) => {
      try {
        const result = await wheel.undoLastBet(socket.data.userId);
        cb?.({
          ok: true, balance: result.balance,
          totals: result.totals, mine: result.mine, undone: result.undone,
        });
        // Broadcast the updated colour totals to every viewer (the live
        // bet pool just shrank), then push this user's fresh balance +
        // personal stake.
        io.of('/wheel').emit('wheel_bet_update', {
          totals: result.totals,
          phaseEndsAt: wheel.state.phaseEndsAt,
        });
        pushUserState(socket.data.userId, socket.id).catch(() => {});
      } catch (e) {
        cb?.({ error: e.message || 'undo_failed' });
      }
    });

    socket.on('wheel_undo_all', async (_unused, cb) => {
      try {
        const result = await wheel.undoAllBets(socket.data.userId);
        cb?.({
          ok: true, balance: result.balance,
          totals: result.totals, mine: result.mine, refunded: result.refunded,
        });
        io.of('/wheel').emit('wheel_bet_update', {
          totals: result.totals,
          phaseEndsAt: wheel.state.phaseEndsAt,
        });
        pushUserState(socket.data.userId, socket.id).catch(() => {});
      } catch (e) {
        cb?.({ error: e.message || 'undo_failed' });
      }
    });
  });

  // Boot the loop. Wrapped in setTimeout so it doesn't run before the
  // rest of the boot finishes attaching things.
  setTimeout(() => { startLoop().catch(e => console.error('[wheel] boot', e.message)); }, 500);
}

module.exports = { attach };
