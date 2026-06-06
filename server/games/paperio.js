// server/games/paperio.js
// ============================================================================
//  Paper.io-style territory game — wallet side only (escrow each ante, pay the
//  winner(s) the pot minus the house fee, refund on cancel). The live grid +
//  game loop live in sockets/paperioSocket.js. Same pattern as RPS / RR.
//
//  Payout rules (set by the socket layer, passed in here as a list):
//   - last player standing  -> winner takes pot * (1 - fee)
//   - timer runs out         -> each survivor gets a share of pot*(1-fee)
//                               proportional to their territory size
//  Either way the house keeps `fee` percent of the whole pot.
// ============================================================================
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');

const HOUSE_FEE_PCT = Math.max(0, Math.min(50, Number(process.env.HOUSE_FEE_PERCENT || 5)));
const MIN_BET = 5;

async function createMatch(userIds, bet) {
  bet = Math.floor(Number(bet));
  if (!Number.isFinite(bet) || bet < MIN_BET) throw new Error('invalid_bet');
  if (!Array.isArray(userIds) || userIds.length < 2) throw new Error('not_enough_players');
  const pot = bet * userIds.length;
  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('paperio','active',$1,$2) RETURNING id`, [bet, pot]
    );
    const sessionId = rows[0].id;
    for (let i = 0; i < userIds.length; i++) {
      await adjustBalance(userIds[i], -bet, 'bet', { refType: 'paperio', refId: `${sessionId}:${i}`, client });
    }
    return { sessionId, pot, feePct: HOUSE_FEE_PCT };
  });
}

// payouts: [{ userId, credits }]. Idempotent (session status + ledger index).
async function finishMatch(sessionId, payouts) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    for (const p of (payouts || [])) {
      if (p.credits > 0) {
        try {
          await adjustBalance(p.userId, p.credits, 'win', {
            refType: 'paperio', refId: `${sessionId}:${p.userId}`, client, metadata: { game: 'paperio' },
          });
        } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
      }
    }
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

async function cancelMatch(sessionId, userIds, bet) {
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT status FROM game_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (!rows.length || rows[0].status !== 'active') return;
    for (let i = 0; i < userIds.length; i++) {
      try {
        await adjustBalance(userIds[i], bet, 'refund', { refType: 'paperio', refId: `${sessionId}:${i}`, client });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }
    await client.query(`UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`, [sessionId]);
  });
}

module.exports = { HOUSE_FEE_PCT, MIN_BET, createMatch, finishMatch, cancelMatch };
