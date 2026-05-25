// server/games/rps.js — best-of-3 RPS persistence + game logic helpers.
// Real-time matchmaking + round flow lives in sockets/rpsSocket.js.
const { withTx, pool } = require('../db');
const { adjustBalance } = require('../wallet');

const CHOICES = new Set(['rock','paper','scissors']);

function winnerOfRound(a, b) {
  if (a === b) return 'tie';
  if ((a === 'rock'     && b === 'scissors') ||
      (a === 'paper'    && b === 'rock')     ||
      (a === 'scissors' && b === 'paper')) return 'a';
  return 'b';
}

/** Create a match row + escrow both bets. Returns { matchId, sessionId }. */
async function createMatch(playerAId, playerBId, betAmount) {
  betAmount = Math.floor(Number(betAmount));
  if (!Number.isFinite(betAmount) || betAmount <= 0) throw new Error('invalid_bet_amount');

  return withTx(async (client) => {
    const { rows: gs } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('rps','active',$1,$2)
       RETURNING id`,
      [betAmount, betAmount * 2]
    );
    const sessionId = gs[0].id;

    // Per-player refId so both 'bet' rows fit under the (ref_type, ref_id, reason) unique index.
    await adjustBalance(playerAId, -betAmount, 'bet', { refType: 'rps', refId: `${sessionId}:a`, client });
    await adjustBalance(playerBId, -betAmount, 'bet', { refType: 'rps', refId: `${sessionId}:b`, client });

    const { rows } = await client.query(
      `INSERT INTO rps_matches (session_id, bet_amount, player_a_id, player_b_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [sessionId, betAmount, playerAId, playerBId]
    );
    return { matchId: rows[0].id, sessionId };
  });
}

async function recordRound(matchId, roundNo, aChoice, bChoice) {
  const winner = winnerOfRound(aChoice, bChoice);
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM rps_matches WHERE id = $1 FOR UPDATE`, [matchId]
    );
    if (!rows.length) throw new Error('match_not_found');
    const m = rows[0];
    if (m.status !== 'active') throw new Error('match_not_active');

    let winnerUserId = null;
    if (winner === 'a') winnerUserId = m.player_a_id;
    if (winner === 'b') winnerUserId = m.player_b_id;

    await client.query(
      `INSERT INTO rps_rounds (match_id, round_no, player_a_choice, player_b_choice, winner_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (match_id, round_no) DO NOTHING`,
      [matchId, roundNo, aChoice, bChoice, winnerUserId]
    );

    let aScore = m.player_a_score + (winner === 'a' ? 1 : 0);
    let bScore = m.player_b_score + (winner === 'b' ? 1 : 0);

    await client.query(
      `UPDATE rps_matches SET player_a_score=$1, player_b_score=$2 WHERE id=$3`,
      [aScore, bScore, matchId]
    );

    return { winner, winnerUserId, aScore, bScore };
  });
}

/** Finalise — winnerUserId = null for draw (refund). */
async function finishMatch(matchId, winnerUserId, reason = 'best_of_3') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM rps_matches WHERE id = $1 FOR UPDATE`, [matchId]
    );
    if (!rows.length) throw new Error('match_not_found');
    const m = rows[0];
    if (m.status !== 'active') return; // idempotent

    const bet  = Number(m.bet_amount);
    const pot  = bet * 2;

    if (winnerUserId) {
      await adjustBalance(winnerUserId, pot, 'win', {
        refType: 'rps', refId: m.session_id, client,
        metadata: { reason },
      });
    } else {
      // Draw → refund both (per-player refId)
      await adjustBalance(m.player_a_id, bet, 'refund', {
        refType: 'rps', refId: `${m.session_id}:a`, client,
        metadata: { reason: 'draw' },
      });
      await adjustBalance(m.player_b_id, bet, 'refund', {
        refType: 'rps', refId: `${m.session_id}:b`, client,
        metadata: { reason: 'draw' },
      });
    }

    await client.query(
      `UPDATE rps_matches
          SET status='finished', winner_id=$1, result_reason=$2, finished_at=NOW()
        WHERE id=$3`,
      [winnerUserId, reason, matchId]
    );
    await client.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
      [m.session_id]
    );
  });
}

async function cancelMatch(matchId, reason = 'cancelled') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM rps_matches WHERE id = $1 FOR UPDATE`, [matchId]
    );
    if (!rows.length) return;
    const m = rows[0];
    if (m.status !== 'active') return;

    const bet = Number(m.bet_amount);
    await adjustBalance(m.player_a_id, bet, 'refund', {
      refType: 'rps', refId: `${m.session_id}:a`, client, metadata: { reason },
    });
    await adjustBalance(m.player_b_id, bet, 'refund', {
      refType: 'rps', refId: `${m.session_id}:b`, client, metadata: { reason },
    });
    await client.query(
      `UPDATE rps_matches SET status='cancelled', result_reason=$1, finished_at=NOW() WHERE id=$2`,
      [reason, matchId]
    );
    await client.query(
      `UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`,
      [m.session_id]
    );
  });
}

module.exports = { CHOICES, winnerOfRound, createMatch, recordRound, finishMatch, cancelMatch };
