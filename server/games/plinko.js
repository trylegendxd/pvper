// server/games/plinko.js — Plinko (Galton board) game logic
// ============================================================================
//  Single-player, server-authoritative, instant-settle house game in the same
//  shape as mines.js. The ball path is generated with the crypto-secure RNG
//  (NEVER Math.random for money). The final bin = number of right-bounces over
//  `rows` rows, which is binomially distributed, so the centre bins are common
//  (low multiplier) and the edges are rare (big multiplier).
//
//  House edge: the published "shapes" below are only RELATIVE multiplier
//  curves. At load each shape is normalised so its expected value equals
//  TARGET_RTP (default 0.97 → 3% edge, matching mines). This GUARANTEES a
//  positive house edge for every (rows, risk) regardless of the exact curve.
//
//  Wallet: each drop debits the bet (reason 'bet') and, if it pays, credits
//  the win (reason 'plinko_payout') in the SAME transaction, both keyed on the
//  session id so the ledger uniqueness index blocks accidental double-moves.
// ============================================================================
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { intInRange } = require('../rng');

const ROWS_OPTIONS = [8, 12, 16];
const RISKS = ['low', 'medium', 'high'];
const TARGET_RTP = Math.min(0.999, Math.max(0.5, Number(process.env.PLINKO_RTP || 0.97)));
const MAX_BET = 1_000_000;

// Relative multiplier shapes — symmetric, big at the edges, small in the
// middle. Higher risk = more extreme. These are normalised below so only the
// SHAPE matters, not the absolute numbers.
const SHAPES = {
  8: {
    low:    [5,  2,  1.2, 1,   0.5, 1,   1.2, 2,  5],
    medium: [12, 3,  1.4, 0.6, 0.4, 0.6, 1.4, 3,  12],
    high:   [28, 5,  1.5, 0.3, 0.2, 0.3, 1.5, 5,  28],
  },
  12: {
    low:    [9,  3,  1.8, 1.3, 1.1, 1,   0.5, 1,   1.1, 1.3, 1.8, 3,  9],
    medium: [22, 6,  3,   1.4, 0.8, 0.5, 0.3, 0.5, 0.8, 1.4, 3,   6,  22],
    high:   [58, 12, 4,   1.2, 0.4, 0.2, 0.2, 0.2, 0.4, 1.2, 4,   12, 58],
  },
  16: {
    low:    [16,  9,  2, 1.4, 1.2, 1.1, 1,   0.7, 0.5, 0.7, 1,   1.1, 1.2, 1.4, 2, 9,  16],
    medium: [50,  15, 5, 2,   1.2, 0.8, 0.5, 0.4, 0.3, 0.4, 0.5, 0.8, 1.2, 2,   5, 15, 50],
    high:   [130, 30, 8, 2.5, 0.8, 0.4, 0.2, 0.2, 0.2, 0.2, 0.2, 0.4, 0.8, 2.5, 8, 30, 130],
  },
};

// Binomial weights C(n,k)/2^n for k = 0..n.
function binomWeights(n) {
  const w = new Array(n + 1);
  const total = 2 ** n;
  let c = 1;
  for (let k = 0; k <= n; k++) { w[k] = c / total; c = (c * (n - k)) / (k + 1); }
  return w;
}

// Normalise each shape so its expected value == TARGET_RTP, rounded to 2dp.
// Frozen so the live tables can't be mutated by a caller.
const TABLES = {};
for (const rows of ROWS_OPTIONS) {
  TABLES[rows] = {};
  const w = binomWeights(rows);
  for (const risk of RISKS) {
    const shape = SHAPES[rows][risk];
    const rawEV = shape.reduce((s, m, k) => s + m * w[k], 0);
    const scale = TARGET_RTP / rawEV;
    TABLES[rows][risk] = Object.freeze(shape.map(m => Math.round(m * scale * 100) / 100));
  }
  Object.freeze(TABLES[rows]);
}
Object.freeze(TABLES);

// Expected return for a (rows, risk) table — useful for tests / auditing.
function expectedReturn(rows, risk) {
  const w = binomWeights(rows);
  return TABLES[rows][risk].reduce((s, m, k) => s + m * w[k], 0);
}

/**
 * Drop one ball. Debits the bet, generates a crypto-random path, pays out the
 * landing bin's multiplier, and finishes the session — all atomically.
 * Returns the path so the client animation can land on the exact server bin.
 */
async function drop(userId, betAmount, rows, risk) {
  const bet = Math.floor(Number(betAmount));
  rows = Number(rows);
  risk = String(risk || '').toLowerCase();

  if (!Number.isFinite(bet) || bet <= 0)  throw new Error('invalid_bet');
  if (bet > MAX_BET)                       throw new Error('amount_too_large');
  if (!ROWS_OPTIONS.includes(rows))        throw new Error('invalid_rows');
  if (!RISKS.includes(risk))               throw new Error('invalid_risk');

  const table = TABLES[rows][risk];

  // Crypto-random path: one left(0)/right(1) decision per row.
  const path = [];
  let binIndex = 0;
  for (let i = 0; i < rows; i++) { const d = intInRange(0, 1); path.push(d); binIndex += d; }
  const multiplier = table[binIndex];

  return withTx(async (client) => {
    const { rows: gs } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('plinko','active',$1,$1) RETURNING id`,
      [bet]
    );
    const sessionId = gs[0].id;

    await adjustBalance(userId, -bet, 'bet', {
      refType: 'plinko', refId: sessionId,
      metadata: { rows, risk }, client,
    });

    const payout = Math.round(bet * multiplier * 100) / 100;   // 2-decimal credits
    if (payout > 0) {
      await adjustBalance(userId, payout, 'plinko_payout', {
        refType: 'plinko', refId: sessionId,
        metadata: { rows, risk, binIndex, multiplier }, client,
      });
    }

    await client.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
      [sessionId]
    );

    const { rows: w } = await client.query(
      'SELECT balance FROM wallets WHERE user_id=$1', [userId]
    );

    return {
      sessionId: String(sessionId),
      rows, risk, path, binIndex, multiplier, payout, bet,
      balance: Number(w[0]?.balance ?? 0),
      multipliers: table,
    };
  });
}

module.exports = {
  drop, expectedReturn,
  ROWS_OPTIONS, RISKS, TABLES, TARGET_RTP, MAX_BET,
};
