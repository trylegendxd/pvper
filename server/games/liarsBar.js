// server/games/liarsBar.js
// ============================================================================
//  Liar's Bar — a bluffing card game with revolver elimination.
//
//  This module owns the wallet side (escrow each player's ante, pay the winner
//  the pot, refund on cancel) plus the deck helpers. The live match state +
//  turn flow lives in sockets/liarsBarSocket.js (modelled on the RPS / RR
//  pattern). Original implementation — only the public game mechanics are
//  shared with the game it's inspired by; no assets/text/code are copied.
//
//  All randomness uses the crypto-secure rng (never Math.random for money).
// ============================================================================
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { secureShuffle } = require('../rng');

// The three "table" card types players bluff about, plus the wild Joker.
const CARD_TYPES = ['A', 'K', 'Q'];   // Ace / King / Queen
const JOKER = 'J';
const HAND_SIZE = 5;
const CHAMBERS  = 6;
const MIN_BET   = 5;

// Deck: 6 each of A / K / Q + 2 Jokers = 20 cards. With up to 4 players × 5
// cards that's exactly one deck dealt out.
function makeDeck() {
  const d = [];
  for (const t of CARD_TYPES) for (let i = 0; i < 6; i++) d.push(t);
  d.push(JOKER, JOKER);
  return secureShuffle(d);
}

// A played card is "valid" for the round's table card if it IS that card or a
// Joker (wild). A play is truthful only when every card it contains is valid.
function cardMatches(card, tableCard) { return card === tableCard || card === JOKER; }

// ── Wallet-aware lifecycle (idempotent via the ledger unique index) ─────────

// Escrow every player's ante atomically. Returns { sessionId, pot }.
async function createMatch(userIds, bet) {
  bet = Math.floor(Number(bet));
  if (!Number.isFinite(bet) || bet < MIN_BET) throw new Error('invalid_bet');
  if (!Array.isArray(userIds) || userIds.length < 2) throw new Error('not_enough_players');
  const pot = bet * userIds.length;
  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('liars_bar','active',$1,$2) RETURNING id`, [bet, pot]
    );
    const sessionId = rows[0].id;
    for (let i = 0; i < userIds.length; i++) {
      await adjustBalance(userIds[i], -bet, 'bet', { refType: 'lb', refId: `${sessionId}:${i}`, client });
    }
    return { sessionId, pot };
  });
}

// Pay the winner the whole pot. Idempotent.
async function finishMatch(sessionId, winnerUserId, pot) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    if (winnerUserId) {
      try {
        await adjustBalance(winnerUserId, pot, 'win', {
          refType: 'lb', refId: sessionId, client, metadata: { game: 'liars_bar' },
        });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

// Refund every ante (match aborted before a winner). Idempotent.
async function cancelMatch(sessionId, userIds, bet) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    for (let i = 0; i < userIds.length; i++) {
      try {
        await adjustBalance(userIds[i], bet, 'refund', { refType: 'lb', refId: `${sessionId}:${i}`, client });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }
    await client.query(`UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

module.exports = {
  CARD_TYPES, JOKER, HAND_SIZE, CHAMBERS, MIN_BET,
  makeDeck, cardMatches,
  createMatch, finishMatch, cancelMatch,
};
