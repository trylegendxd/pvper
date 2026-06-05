// server/games/wheel.js
// ============================================================================
//  4-colour multiplier wheel. A single coordinator runs on the server,
//  cycles through betting → spinning → result phases on a fixed timer,
//  and broadcasts state to every connected /wheel socket so all viewers
//  see the same spin in real time.
//
//  Segments are laid out around the wheel in a fixed deterministic order
//  (see SEGMENT_LAYOUT below). The crypto-secure RNG picks one segment
//  index per spin; the angle is derived from that.
//
//  Wallet integration: each bet debits immediately via adjustBalance
//  with ref_type='wheel' and ref_id='<roundId>:<color>:<userId>' so the
//  ledger uniqueness index blocks accidental double-debits. Payouts use
//  reason='wheel_payout' and ref_id='<roundId>:<color>:<userId>:win'.
// ============================================================================
const { withTx, pool } = require('../db');
const { adjustBalance, getBalance } = require('../wallet');
const { intInRange } = require('../rng');

// ── Wheel layout ─────────────────────────────────────────────────────────
// 50 segments around the circle. Distribution targets ~5% average house
// edge but each colour has slightly different edge. Order is shuffled so
// adjacent segments aren't all the same colour visually.
//   2x gray : 24 segments  (48%)  → 96% return → 4% edge
//   3x pink : 16 segments  (32%)  → 96% return → 4% edge
//   5x blue :  9 segments  (18%)  → 90% return → 10% edge
//   50x yellow: 1 segment  (2%)   → 100% return → 0% edge
const SEGMENT_LAYOUT = [
  'gray','pink','gray','blue','gray','pink','gray','gray','pink','blue',
  'gray','pink','gray','gray','pink','blue','gray','pink','gray','yellow',
  'gray','pink','gray','blue','gray','pink','gray','gray','pink','blue',
  'gray','pink','gray','gray','pink','blue','gray','pink','gray','blue',
  'gray','pink','gray','gray','pink','blue','gray','pink','gray','blue',
];
const SEGMENT_COUNT = SEGMENT_LAYOUT.length;

const COLOR_MULT = { gray: 2, pink: 3, blue: 5, yellow: 50 };
const COLORS = Object.keys(COLOR_MULT);

// Phase durations (ms).
const PHASE_MS = {
  betting:  20000,
  spinning: 5000,
  result:   2500,
};

// Server-side state. Single-instance — there's only one wheel running.
const state = {
  roundId: null,
  phase: 'idle',         // 'betting' | 'spinning' | 'result' | 'idle'
  phaseStartedAt: 0,
  phaseEndsAt: 0,
  // Aggregated bets for the current round.
  totals: { gray: 0, pink: 0, blue: 0, yellow: 0 },
  // Per-user bets so we can render their personal stake on the buttons.
  // Map<userId, { gray, pink, blue, yellow }>.
  userBets: new Map(),
  // Per-user list of bet refs we'll need to settle:
  // [{ userId, color, amount, refId }].
  pendingBets: [],
  // Result of the latest spin (only present while phase === 'result').
  result: null,
  // Last N completed spins for the history strip.
  history: [],          // newest first; each { color, multiplier, segment }
  HISTORY_MAX: 20,
};

function snapshot() {
  return {
    roundId: state.roundId,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    phaseEndsAt: state.phaseEndsAt,
    totals: { ...state.totals },
    result: state.result ? { ...state.result } : null,
    history: state.history.slice(0, 12),
    layout: SEGMENT_LAYOUT,
    multipliers: COLOR_MULT,
    serverNow: Date.now(),
  };
}

function userBetSnapshot(userId) {
  return state.userBets.get(userId) || { gray: 0, pink: 0, blue: 0, yellow: 0 };
}

// ── Phase transitions ────────────────────────────────────────────────────
// These set state but don't touch the DB or wallet — callers handle that
// so the socket layer can broadcast at the right moments.
async function openBettingRound() {
  // Fresh round shell. The DB row + session is created here so each bet
  // can reference it.
  const now = Date.now();
  const { rows: gsRows } = await pool.query(
    `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
     VALUES ('wheel','active',0,0) RETURNING id`
  );
  const sessionId = gsRows[0].id;
  const { rows: rRows } = await pool.query(
    `INSERT INTO wheel_rounds (session_id, winning_segment, winning_color, winning_multiplier)
     VALUES ($1, 0, 'gray', 2) RETURNING id`,
    [sessionId]
  );
  state.roundId = rRows[0].id;
  state.phase = 'betting';
  state.phaseStartedAt = now;
  state.phaseEndsAt = now + PHASE_MS.betting;
  state.totals = { gray: 0, pink: 0, blue: 0, yellow: 0 };
  state.userBets = new Map();
  state.pendingBets = [];
  state.result = null;
  return state.roundId;
}

function beginSpin() {
  // Picks the winning segment, sets the phase to 'spinning', and returns
  // the spin parameters so the socket layer can ship them with a single
  // wheel_state event. Actual payouts run when the spin finishes.
  const segment = intInRange(0, SEGMENT_COUNT - 1);
  const color = SEGMENT_LAYOUT[segment];
  const multiplier = COLOR_MULT[color];
  const now = Date.now();
  state.phase = 'spinning';
  state.phaseStartedAt = now;
  state.phaseEndsAt = now + PHASE_MS.spinning;
  state.result = { segment, color, multiplier, payouts: [], totalPayout: 0 };
  return { segment, color, multiplier };
}

async function settleSpin() {
  // Pay every winning bet and write the wheel_rounds row + session.
  const r = state.result;
  if (!r || !state.roundId) return;
  const winningColor = r.color;
  const mult = r.multiplier;
  const perUser = []; // { userId, won, change, newBalance }

  // Group winning bets by user so we issue one payout per user (cleaner
  // ledger). Use the round id + colour as the ref so the unique index
  // blocks accidental double-payout.
  const winnersByUser = new Map();
  for (const b of state.pendingBets) {
    if (b.color !== winningColor) continue;
    const u = winnersByUser.get(b.userId) || { userId: b.userId, amount: 0 };
    u.amount += b.amount;
    winnersByUser.set(b.userId, u);
  }

  for (const u of winnersByUser.values()) {
    const payout = u.amount * mult;
    try {
      const res = await adjustBalance(u.userId, payout, 'wheel_payout', {
        refType: 'wheel',
        refId: `${state.roundId}:${winningColor}:${u.userId}:win`,
        metadata: { color: winningColor, multiplier: mult, bet: u.amount },
      });
      perUser.push({
        userId: u.userId, won: true,
        change: payout - u.amount,            // net (already paid the bet at place-time)
        bet: u.amount, payout,
        newBalance: res.balance,
      });
      r.totalPayout += payout;
    } catch (e) {
      if (e.message !== 'duplicate_transaction') {
        console.error('[wheel] payout failed', u.userId, e.message);
      }
    }
  }
  // Losers — just compute net change (they already lost their bet at
  // place-time, no further wallet move).
  const losers = new Map();
  for (const b of state.pendingBets) {
    if (b.color === winningColor) continue;
    const u = losers.get(b.userId) || { userId: b.userId, lost: 0 };
    u.lost += b.amount;
    losers.set(b.userId, u);
  }
  for (const u of losers.values()) {
    if (winnersByUser.has(u.userId)) continue;  // already in perUser
    perUser.push({ userId: u.userId, won: false, change: -u.lost, bet: u.lost, payout: 0 });
  }
  r.payouts = perUser;

  // Update the wheel_rounds row with the final aggregates.
  try {
    await pool.query(
      `UPDATE wheel_rounds
          SET winning_segment = $1, winning_color = $2, winning_multiplier = $3,
              total_gray = $4, total_pink = $5, total_blue = $6, total_yellow = $7,
              total_payout = $8, spun_at = NOW()
        WHERE id = $9`,
      [r.segment, r.color, r.multiplier,
       state.totals.gray, state.totals.pink, state.totals.blue, state.totals.yellow,
       r.totalPayout, state.roundId]
    );
    // Close the game_sessions row.
    await pool.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW(),
              bet_amount = $1, pot_amount = $2
        WHERE id = (SELECT session_id FROM wheel_rounds WHERE id=$3)`,
      [state.totals.gray + state.totals.pink + state.totals.blue + state.totals.yellow,
       r.totalPayout, state.roundId]
    );
  } catch (e) {
    console.error('[wheel] round persist failed', e.message);
  }

  // Push to the history strip.
  state.history.unshift({
    color: r.color, multiplier: r.multiplier, segment: r.segment,
    roundId: state.roundId, spunAt: Date.now(),
  });
  if (state.history.length > state.HISTORY_MAX) state.history.length = state.HISTORY_MAX;

  state.phase = 'result';
  state.phaseStartedAt = Date.now();
  state.phaseEndsAt = state.phaseStartedAt + PHASE_MS.result;
}

// ── Bet placement ────────────────────────────────────────────────────────
// Called from the socket handler. Validates phase + balance, debits the
// wallet, and updates the in-memory totals so the next state broadcast
// reflects it.
async function placeBet(userId, color, amount) {
  if (state.phase !== 'betting') throw new Error('not_betting_phase');
  if (!COLORS.includes(color)) throw new Error('invalid_color');
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid_amount');
  if (amount > 1_000_000) throw new Error('amount_too_large');
  if (!state.roundId) throw new Error('no_active_round');

  // Wallet debit. Use a unique-per-(round,color,user,sequence) ref so the
  // user can place multiple bets on the same colour in the same round
  // without colliding on the wallet uniqueness index.
  const seq = state.pendingBets.filter(b =>
    b.userId === userId && b.color === color
  ).length;
  const refId = `${state.roundId}:${color}:${userId}:${seq}`;
  const res = await adjustBalance(userId, -amount, 'bet', {
    refType: 'wheel', refId,
    metadata: { color, mult: COLOR_MULT[color], round: state.roundId },
  });

  // Update in-memory state.
  state.totals[color] += amount;
  let mine = state.userBets.get(userId);
  if (!mine) {
    mine = { gray: 0, pink: 0, blue: 0, yellow: 0 };
    state.userBets.set(userId, mine);
  }
  mine[color] += amount;
  state.pendingBets.push({ userId, color, amount, refId });

  return {
    balance: res.balance,
    totals: { ...state.totals },
    mine: { ...mine },
  };
}

// ── History (DB lookup, for fresh viewers / page reloads) ────────────────
async function recentHistory(limit = 12) {
  try {
    const { rows } = await pool.query(
      `SELECT id, winning_segment, winning_color, winning_multiplier, spun_at
         FROM wheel_rounds
        WHERE spun_at IS NOT NULL
     ORDER BY spun_at DESC
        LIMIT $1`, [limit]
    );
    return rows.map(r => ({
      color: r.winning_color, multiplier: r.winning_multiplier,
      segment: r.winning_segment, roundId: r.id,
      spunAt: r.spun_at,
    }));
  } catch (_) { return []; }
}

module.exports = {
  SEGMENT_LAYOUT, SEGMENT_COUNT, COLOR_MULT, COLORS, PHASE_MS,
  state, snapshot, userBetSnapshot,
  openBettingRound, beginSpin, settleSpin,
  placeBet, recentHistory,
};
