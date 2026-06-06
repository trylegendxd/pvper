// server/games/rouletteRoyale.js
// ============================================================================
//  Multiplayer "Russian Roulette" — blackjack-per-turn elimination.
//  This module owns the wallet side (escrow each player's ante, pay the
//  winner the pot, refund on cancel) plus the card/gun helpers. The live
//  match state + turn flow lives in sockets/rrSocket.js, exactly like RPS.
//
//  All randomness uses the crypto-secure rng (never Math.random for money).
// ============================================================================
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { intInRange } = require('../rng');

const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SUITS = ['♠','♥','♦','♣'];

function drawCard() { return { r: RANKS[intInRange(0, 12)], s: SUITS[intInRange(0, 3)] }; }
function cardVal(c) {
  if (c.r === 'A') return 11;
  if (['10', 'J', 'Q', 'K'].includes(c.r)) return 10;
  return Number(c.r);
}
function handValue(cards) {
  let t = 0, a = 0;
  for (const c of cards) { if (c.hidden) continue; t += cardVal(c); if (c.r === 'A') a++; }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return t;
}
function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }

const MIN_BET = 5;

// Escrow every player's ante atomically. Returns { sessionId, pot }.
async function createMatch(userIds, bet) {
  bet = Math.floor(Number(bet));
  if (!Number.isFinite(bet) || bet < MIN_BET) throw new Error('invalid_bet');
  if (!Array.isArray(userIds) || userIds.length < 2) throw new Error('not_enough_players');
  const pot = bet * userIds.length;
  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('roulette_royale','active',$1,$2) RETURNING id`, [bet, pot]
    );
    const sessionId = rows[0].id;
    // Per-player refId so each 'bet' row fits the (ref_type, ref_id, reason)
    // unique index — also lets cancelMatch refund each one idempotently.
    for (let i = 0; i < userIds.length; i++) {
      await adjustBalance(userIds[i], -bet, 'bet', { refType: 'rr', refId: `${sessionId}:${i}`, client });
    }
    return { sessionId, pot };
  });
}

// Pay the winner the whole pot. Idempotent: guarded by the session status
// and the wallet ledger unique index.
async function finishMatch(sessionId, winnerUserId, pot) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    if (winnerUserId) {
      try {
        await adjustBalance(winnerUserId, pot, 'win', {
          refType: 'rr', refId: sessionId, client, metadata: { game: 'roulette_royale' },
        });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

// Refund every ante (match never really started / aborted). Idempotent.
async function cancelMatch(sessionId, userIds, bet) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    for (let i = 0; i < userIds.length; i++) {
      try {
        await adjustBalance(userIds[i], bet, 'refund', { refType: 'rr', refId: `${sessionId}:${i}`, client });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }
    await client.query(`UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

module.exports = {
  RANKS, SUITS, MIN_BET,
  drawCard, cardVal, handValue, isBlackjack,
  createMatch, finishMatch, cancelMatch,
};
