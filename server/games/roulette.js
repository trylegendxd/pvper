// server/games/roulette.js — European wheel (single zero), multi-bet per spin.
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { intInRange } = require('../rng');

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function colorOf(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// European wheel pocket order, clockwise starting at 0
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23,
  10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

const BET_TYPES = new Set([
  'straight','red','black','odd','even','low','high','dozen','column',
]);

// Multipliers — returned amount on win INCLUDES original stake
// (e.g. 1:1 even-money = stake × 2)
const PAYOUT_MULT = {
  straight: 36,   // 35:1 + stake
  red:      2,    // 1:1 + stake
  black:    2,
  odd:      2,
  even:     2,
  low:      2,
  high:     2,
  dozen:    3,    // 2:1 + stake
  column:   3,
};

function betWins(bet, result, resultColor) {
  const { betType, betValue } = bet;
  if (result === 0) {
    // Only 'straight 0' wins on green
    return betType === 'straight' && betValue === 0;
  }
  switch (betType) {
    case 'straight': return result === betValue;
    case 'red':      return resultColor === 'red';
    case 'black':    return resultColor === 'black';
    case 'odd':      return (result % 2) === 1;
    case 'even':     return (result % 2) === 0;
    case 'low':      return result >= 1 && result <= 18;
    case 'high':     return result >= 19 && result <= 36;
    case 'dozen': {
      const dz = Math.ceil(result / 12); // 1..3
      return betValue === dz;
    }
    case 'column': {
      // Column 1: 1,4,7,...,34  (n % 3 === 1)
      // Column 2: 2,5,8,...,35  (n % 3 === 2)
      // Column 3: 3,6,9,...,36  (n % 3 === 0)
      const col = result % 3 === 0 ? 3 : result % 3;
      return betValue === col;
    }
    default: return false;
  }
}

function validateBet(b) {
  if (!b || typeof b !== 'object') return 'bad_bet';
  if (!BET_TYPES.has(b.betType)) return 'invalid_bet_type';
  const amt = Math.floor(Number(b.betAmount));
  if (!Number.isFinite(amt) || amt <= 0) return 'invalid_bet_amount';
  b.betAmount = amt;
  if (b.betType === 'straight') {
    const v = Number(b.betValue);
    if (!Number.isInteger(v) || v < 0 || v > 36) return 'invalid_bet_value';
    b.betValue = v;
  } else if (b.betType === 'dozen' || b.betType === 'column') {
    const v = Number(b.betValue);
    if (![1,2,3].includes(v)) return 'invalid_bet_value';
    b.betValue = v;
  } else {
    b.betValue = null;
  }
  return null;
}

/**
 * Place one OR multiple bets, spin once, settle once.
 *
 * @param userId
 * @param bets  Array of { betType, betValue, betAmount }
 * @returns { number, color, payout, totalBet, balance, sessionId, results: [{...}] }
 */
async function spinMulti(userId, bets) {
  if (!Array.isArray(bets) || bets.length === 0) throw new Error('no_bets');
  if (bets.length > 30) throw new Error('too_many_bets');

  for (const b of bets) {
    const err = validateBet(b);
    if (err) throw new Error(err);
  }
  const totalBet = bets.reduce((s, b) => s + b.betAmount, 0);
  if (totalBet <= 0) throw new Error('invalid_bet_amount');

  const result      = intInRange(0, 36);
  const resultColor = colorOf(result);

  // Per-bet outcomes
  const perBet = bets.map(b => {
    const won = betWins(b, result, resultColor);
    return {
      ...b,
      won,
      payout: won ? b.betAmount * PAYOUT_MULT[b.betType] : 0,
    };
  });
  const totalPayout = perBet.reduce((s, x) => s + x.payout, 0);

  return withTx(async (client) => {
    const { rows: gsRows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount, finished_at)
       VALUES ('roulette','finished',$1,$1,NOW())
       RETURNING id`,
      [totalBet]
    );
    const sessionId = gsRows[0].id;

    await adjustBalance(userId, -totalBet, 'bet', {
      refType: 'roulette', refId: sessionId,
      metadata: { bets: bets.map(b => ({ t:b.betType, v:b.betValue, a:b.betAmount })) },
      client,
    });

    // Insert one row per bet, all sharing this session_id + result
    for (const b of perBet) {
      await client.query(
        `INSERT INTO roulette_spins
           (session_id, user_id, bet_type, bet_value, bet_amount, result_number, result_color, payout)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sessionId, userId, b.betType, b.betValue, b.betAmount, result, resultColor, b.payout]
      );
    }

    let balance = null;
    if (totalPayout > 0) {
      const r = await adjustBalance(userId, totalPayout, 'roulette_payout', {
        refType: 'roulette', refId: sessionId,
        metadata: { result, resultColor, totalPayout },
        client,
      });
      balance = r.balance;
    } else {
      const b = await client.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
      balance = Number(b.rows[0]?.balance ?? 0);
    }

    return {
      sessionId,
      number: result,
      color:  resultColor,
      wheelIndex: WHEEL_ORDER.indexOf(result),
      payout: totalPayout,
      totalBet,
      balance,
      results: perBet.map(b => ({
        betType: b.betType, betValue: b.betValue,
        betAmount: b.betAmount, won: b.won, payout: b.payout,
      })),
    };
  });
}

// Legacy single-bet helper used in older callers
async function spin(userId, betType, betValue, betAmount) {
  return spinMulti(userId, [{ betType, betValue, betAmount }]);
}

module.exports = { spin, spinMulti, colorOf, RED_NUMBERS, WHEEL_ORDER };
