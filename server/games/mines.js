// server/games/mines.js — Mines game logic (server-authoritative mine placement)
const { withTx } = require('../db');
const { adjustBalance } = require('../wallet');
const { intInRange } = require('../rng');

const TOTAL_TILES = 25;

// In-memory active game sessions (play-money; restart-safe is fine)
const activeSessions = new Map(); // String(sessionId) → gameState

function computeMultiplier(reveals, mines) {
  if (reveals === 0) return 1.0;
  const safe = TOTAL_TILES - mines;
  let raw = 1.0;
  for (let i = 0; i < reveals; i++) raw *= (TOTAL_TILES - i) / (safe - i);
  return Math.round(raw * 0.97 * 100) / 100; // 3 % house edge, rounded to 2dp
}

async function startGame(userId, betAmount, mineCount) {
  const bet   = Math.floor(Number(betAmount));
  const mines = Math.floor(Number(mineCount));
  if (!Number.isFinite(bet)   || bet   <= 0)              throw new Error('invalid_bet');
  if (!Number.isFinite(mines) || mines < 1 || mines > 24) throw new Error('invalid_mine_count');

  // Unique random mine positions
  const pos = new Set();
  while (pos.size < mines) pos.add(intInRange(0, 24));
  const minePositions = Array.from(pos);

  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('mines','active',$1,$1) RETURNING id`,
      [bet]
    );
    const sessionId = rows[0].id;

    await adjustBalance(userId, -bet, 'bet', {
      refType: 'mines', refId: sessionId,
      metadata: { mineCount: mines },
      client,
    });

    const { rows: w } = await client.query(
      'SELECT balance FROM wallets WHERE user_id=$1', [userId]
    );

    activeSessions.set(String(sessionId), {
      sessionId, userId, bet, mines, minePositions,
      revealed: new Set(), revealedCount: 0, status: 'active',
    });

    return {
      sessionId:  String(sessionId),
      balance:    Number(w[0]?.balance ?? 0),
      mineCount:  mines,
      totalTiles: TOTAL_TILES,
    };
  });
}

async function _finishCashOut(userId, key, state) {
  state.status = 'won';
  activeSessions.delete(key);
  const mult   = computeMultiplier(state.revealedCount, state.mines);
  const payout = Math.round(state.bet * mult * 100) / 100;   // 2-decimal credits

  return withTx(async (client) => {
    await client.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
      [state.sessionId]
    );
    const r = await adjustBalance(userId, payout, 'mines_payout', {
      refType: 'mines', refId: state.sessionId,
      metadata: { multiplier: mult, revealedCount: state.revealedCount },
      client,
    });
    return {
      status:        'won',
      payout,
      multiplier:    mult,
      minePositions: state.minePositions,
      balance:       r.balance,
    };
  });
}

async function revealTile(userId, sessionId, tileIndex) {
  const key   = String(sessionId);
  const state = activeSessions.get(key);
  if (!state || String(state.userId) !== String(userId)) throw new Error('invalid_session');
  if (state.status !== 'active')                          throw new Error('game_over');
  if (tileIndex < 0 || tileIndex >= TOTAL_TILES)          throw new Error('invalid_tile');
  if (state.revealed.has(tileIndex))                      throw new Error('already_revealed');

  state.revealed.add(tileIndex);

  if (state.minePositions.includes(tileIndex)) {
    state.status = 'lost';
    activeSessions.delete(key);
    withTx(async c =>
      c.query(`UPDATE game_sessions SET status='finished',finished_at=NOW() WHERE id=$1`,
        [state.sessionId])
    ).catch(() => {});
    return {
      hit: 'mine', tileIndex,
      minePositions: state.minePositions,
      multiplier: 0, status: 'lost',
    };
  }

  state.revealedCount++;
  const safe = TOTAL_TILES - state.mines;
  const mult = computeMultiplier(state.revealedCount, state.mines);
  const nxt  = state.revealedCount < safe
    ? computeMultiplier(state.revealedCount + 1, state.mines)
    : null;

  // Auto-cashout when all safe tiles are found
  if (state.revealedCount >= safe) return _finishCashOut(userId, key, state);

  return {
    hit: 'safe', tileIndex,
    multiplier: mult, nextMultiplier: nxt,
    revealedCount: state.revealedCount,
    status: 'active',
  };
}

async function cashOut(userId, sessionId) {
  const key   = String(sessionId);
  const state = activeSessions.get(key);
  if (!state || String(state.userId) !== String(userId)) throw new Error('invalid_session');
  if (state.status !== 'active')                          throw new Error('game_over');
  if (state.revealedCount === 0)                          throw new Error('no_reveals');
  return _finishCashOut(userId, key, state);
}

module.exports = { startGame, revealTile, cashOut, computeMultiplier };
