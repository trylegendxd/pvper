// server/routes/gameRoutes.js — HTTP endpoints for roulette/blackjack/mines + history
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const roulette     = require('../games/roulette');
const blackjack    = require('../games/blackjack');
const mines        = require('../games/mines');
const ranking      = require('../games/shooterRanking');
const achievements = require('../games/shooterAchievements');
const { pool }     = require('../db');

const router = express.Router();

// ── SHOOTER ranking ───────────────────────────────────────────────────────
// Lightweight read used by the lobby/dashboard to render rank + requirements.
router.get('/shooter/stats', requireAuth, async (req, res) => {
  try {
    const stats = await ranking.publicStatsFor(req.session.userId);
    res.json({
      ok: true,
      ranking: stats,
      requirements: ranking.LOBBY_REQUIREMENTS,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'stats_failed' });
  }
});

// Personal shooter match history. Pulls every game_sessions row of
// game_type='shooter' the requesting user participated in (via the
// wallet ledger join on ref_type='shooter') and rolls up their net
// credit change per match. Returns the most recent N matches.
router.get('/shooter/my-matches', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const { rows } = await pool.query(`
      WITH my_tx AS (
        SELECT
          -- ref_id is sometimes "<session_id>" and sometimes
          -- "<session_id>:a", "<session_id>:b", etc. Split on ':' to
          -- get the bare session id either way.
          split_part(ref_id, ':', 1) AS session_id,
          SUM(amount)::bigint AS net,
          MAX(created_at) AS last_tx
        FROM wallet_transactions
        WHERE user_id = $1
          AND ref_type = 'shooter'
          AND ref_id IS NOT NULL
        GROUP BY split_part(ref_id, ':', 1)
      )
      SELECT
        gs.id AS session_id,
        gs.bet_amount,
        gs.status,
        gs.finished_at,
        gs.created_at,
        mt.net,
        ss.lobby_id,
        ss.result_reason,
        ss.player_a_kills,
        ss.player_b_kills,
        ss.winner_id,
        ss.player_a_id,
        ss.player_b_id
      FROM my_tx mt
      JOIN game_sessions gs ON gs.id::text = mt.session_id
      LEFT JOIN shooter_sessions ss ON ss.session_id = gs.id
      WHERE gs.game_type = 'shooter'
      ORDER BY COALESCE(gs.finished_at, gs.created_at) DESC NULLS LAST,
               mt.last_tx DESC
      LIMIT $2
    `, [req.session.userId, limit]);
    res.json({ ok: true, matches: rows });
  } catch (e) {
    res.status(400).json({ error: e.message || 'my_matches_failed' });
  }
});

// Public profile for a player (by username). Returns their shooter
// stats + a count of their earned achievements. Used by /profile.html.
router.get('/shooter/profile/:username', requireAuth, async (req, res) => {
  try {
    const uname = String(req.params.username || '').trim();
    if (!uname) return res.status(400).json({ error: 'missing_username' });
    const { rows: u } = await pool.query(
      `SELECT id, username, is_admin, display_name, avatar, bio, created_at FROM users
        WHERE lower(username) = lower($1)`,
      [uname]
    );
    if (!u.length) return res.status(404).json({ error: 'not_found' });
    const user = u[0];

    const stats = await ranking.publicStatsFor(user.id);
    const { rows: achRows } = await pool.query(
      `SELECT a.key, a.name, a.icon, ua.earned_at
         FROM user_achievements ua
         JOIN achievements a ON a.id = ua.achievement_id
        WHERE ua.user_id = $1
     ORDER BY ua.earned_at DESC
        LIMIT 12`, [user.id]
    );
    const { rows: achCount } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_achievements WHERE user_id = $1`,
      [user.id]
    );

    res.json({
      ok: true,
      profile: {
        username: user.username,
        display_name: user.display_name || null,
        avatar: user.avatar || null,
        bio: user.bio || null,
        is_admin: user.is_admin,
        member_since: user.created_at,
        stats,
        achievements: achRows,
        achievementsTotal: achCount[0]?.n || 0,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'profile_failed' });
  }
});

// All achievements + whether the player has earned each. Locked rows
// have earned_at = null. Used by /achievements.html to render the grid.
router.get('/shooter/achievements', requireAuth, async (req, res) => {
  try {
    const list = await achievements.listForUser(req.session.userId);
    res.json({ ok: true, achievements: list });
  } catch (e) {
    res.status(400).json({ error: e.message || 'achievements_failed' });
  }
});

// Top-N leaderboard by MMR — capped, public to logged-in players.
// Includes both username (login id) and display_name so the client can
// render the display name when set and fall back to the username.
router.get('/shooter/leaderboard', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.username, u.display_name, u.avatar,
             s.mmr, s.level, s.wins, s.losses, s.kills, s.deaths, s.total_matches
        FROM shooter_player_stats s
        JOIN users u ON u.id = s.user_id
    ORDER BY s.mmr DESC
       LIMIT 25
    `);
    res.json({ ok: true, leaderboard: rows });
  } catch (e) {
    res.status(400).json({ error: e.message || 'leaderboard_failed' });
  }
});

// ── ROULETTE ──────────────────────────────────────────────────────────────
router.post('/roulette/spin', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    let bets = Array.isArray(body.bets) ? body.bets : null;
    if (!bets) {
      const { betType, betValue, betAmount } = body;
      bets = [{ betType, betValue, betAmount }];
    }
    const result = await roulette.spinMulti(req.session.userId, bets);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'spin_failed' });
  }
});

router.get('/roulette/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bet_type, bet_value, bet_amount, result_number, result_color, payout, created_at
       FROM roulette_spins
      WHERE user_id = $1
   ORDER BY created_at DESC LIMIT 25`,
    [req.session.userId]
  );
  res.json({ history: rows });
});

// ── BLACKJACK ─────────────────────────────────────────────────────────────
router.post('/blackjack/start', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // Multi-hand: { bets: [25, 50, 100] } — atomically opens up to 3 hands.
    if (Array.isArray(body.bets) && body.bets.length) {
      const hands = await blackjack.startBatch(req.session.userId, body.bets);
      return res.json({ ok: true, hands });
    }
    // Single-hand (back-compat): { betAmount }
    const hand = await blackjack.start(req.session.userId, body.betAmount);
    res.json({ ok: true, hand, hands: [hand] });
  } catch (e) {
    res.status(400).json({ error: e.message || 'start_failed' });
  }
});
router.post('/blackjack/hit', requireAuth, async (req, res) => {
  try {
    const { handId } = req.body || {};
    const hand = await blackjack.hit(req.session.userId, handId);
    res.json({ ok: true, hand });
  } catch (e) {
    res.status(400).json({ error: e.message || 'hit_failed' });
  }
});
router.post('/blackjack/stand', requireAuth, async (req, res) => {
  try {
    const { handId } = req.body || {};
    const hand = await blackjack.stand(req.session.userId, handId);
    res.json({ ok: true, hand });
  } catch (e) {
    res.status(400).json({ error: e.message || 'stand_failed' });
  }
});
router.post('/blackjack/double', requireAuth, async (req, res) => {
  try {
    const { handId } = req.body || {};
    const hand = await blackjack.doubleDown(req.session.userId, handId);
    res.json({ ok: true, hand });
  } catch (e) {
    res.status(400).json({ error: e.message || 'double_failed' });
  }
});
router.get('/blackjack/active', requireAuth, async (req, res) => {
  const hands = await blackjack.getActive(req.session.userId);
  // Keep `hand` for any old client that still uses it (first active).
  res.json({ hands, hand: hands[0] || null });
});

// ── MINES ─────────────────────────────────────────────────────────────────
router.post('/mines/start', requireAuth, async (req, res) => {
  try {
    const { betAmount, mineCount } = req.body || {};
    const result = await mines.startGame(req.session.userId, betAmount, mineCount);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'start_failed' });
  }
});

router.post('/mines/reveal', requireAuth, async (req, res) => {
  try {
    const { sessionId, tileIndex } = req.body || {};
    if (sessionId == null || tileIndex == null) throw new Error('missing_params');
    const result = await mines.revealTile(req.session.userId, sessionId, Number(tileIndex));
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'reveal_failed' });
  }
});

router.post('/mines/cashout', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) throw new Error('missing_session');
    const result = await mines.cashOut(req.session.userId, sessionId);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message || 'cashout_failed' });
  }
});

module.exports = router;
