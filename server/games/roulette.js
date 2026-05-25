// server/games/roulette.js — vs house, crypto RNG.
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { intInRange } = require('../rng');

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function colorOf(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

const BET_TYPES = new Set(['red','black','odd','even','low','high','number']);

/**
 * Spin roulette for a user.
 * Returns { number, color, payout, balance, sessionId }.
 */
async function spin(userId, betType, betValue, betAmount) {
  if (!BET_TYPES.has(betType)) throw new Error('invalid_bet_type');
  betAmount = Math.floor(Number(betAmount));
  if (!Number.isFinite(betAmount) || betAmount <= 0) throw new Error('invalid_bet_amount');

  if (betType === 'number') {
    betValue = Number(betValue);
    if (!Number.isInteger(betValue) || betValue < 0 || betValue > 36) throw new Error('invalid_bet_value');
  } else {
    betValue = null;
  }

  const result = intInRange(0, 36);
  const resultColor = colorOf(result);
  const payout = computePayout(betType, betValue, betAmount, result, resultColor);

  return withTx(async (client) => {
    // 1) Create game_session row
    const { rows: gsRows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount, finished_at)
       VALUES ('roulette','finished',$1,$1,NOW())
       RETURNING id`,
      [betAmount]
    );
    const sessionId = gsRows[0].id;

    // 2) Deduct bet
    await adjustBalance(userId, -betAmount, 'bet', {
      refType: 'roulette', refId: sessionId,
      metadata: { betType, betValue }, client,
    });

    // 3) Insert spin row
    await client.query(
      `INSERT INTO roulette_spins
         (session_id, user_id, bet_type, bet_value, bet_amount, result_number, result_color, payout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sessionId, userId, betType, betValue, betAmount, result, resultColor, payout]
    );

    // 4) Pay out (idempotent via unique index on ref_type+ref_id+reason)
    let balance = null;
    if (payout > 0) {
      const r = await adjustBalance(userId, payout, 'roulette_payout', {
        refType: 'roulette', refId: sessionId,
        metadata: { result, resultColor, payout }, client,
      });
      balance = r.balance;
    } else {
      // No payout — fetch current balance
      const b = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
      balance = Number(b.rows[0]?.balance ?? 0);
    }

    return { sessionId, number: result, color: resultColor, payout, balance };
  });
}

function computePayout(betType, betValue, betAmount, result, resultColor) {
  if (result === 0 && betType !== 'number') return 0;
  switch (betType) {
    case 'red':    return resultColor === 'red'    ? betAmount * 2 : 0;
    case 'black':  return resultColor === 'black'  ? betAmount * 2 : 0;
    case 'odd':    return (result % 2 === 1)       ? betAmount * 2 : 0;
    case 'even':   return (result !== 0 && result % 2 === 0) ? betAmount * 2 : 0;
    case 'low':    return (result >= 1 && result <= 18)  ? betAmount * 2 : 0;
    case 'high':   return (result >= 19 && result <= 36) ? betAmount * 2 : 0;
    case 'number': return (result === betValue)    ? betAmount * 36 : 0;
    default: return 0;
  }
}

module.exports = { spin, colorOf, RED_NUMBERS };
