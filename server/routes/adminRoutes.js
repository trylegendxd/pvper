// server/routes/adminRoutes.js — protected admin endpoints
const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const { pool } = require('../db');
const { adjustBalance } = require('../wallet');
const rps      = require('../games/rps');
const shooter  = require('../games/shooter');

const router = express.Router();
router.use(requireAdmin);

// ── Users ─────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.is_admin, u.created_at, u.last_login_at,
           COALESCE(w.balance, 0) AS balance
      FROM users u
 LEFT JOIN wallets w ON w.user_id = u.id
  ORDER BY u.created_at DESC
     LIMIT 200
  `);
  res.json({ users: rows });
});

// ── Wallet adjustment (manual credit/debit) ──────────────────────────────
router.post('/wallet/adjust', async (req, res) => {
  try {
    const { userId, amount, reason } = req.body || {};
    if (!userId || !Number.isInteger(Number(amount)) || !reason) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const result = await adjustBalance(userId, Number(amount), 'admin_adjust', {
      refType: 'admin', refId: req.session.userId, metadata: { note: reason },
    });
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_id, details)
       VALUES ($1, 'wallet_adjust', $2, $3::jsonb)`,
      [req.session.userId, userId, JSON.stringify({ amount, reason })]
    );
    res.json({ ok: true, balance: result.balance });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/wallet/transactions', async (req, res) => {
  const userId = req.query.userId;
  const params = userId ? [userId] : [];
  const where  = userId ? 'WHERE user_id = $1' : '';
  const { rows } = await pool.query(
    `SELECT id, user_id, amount, balance_after, reason, ref_type, ref_id, metadata, created_at
       FROM wallet_transactions ${where}
   ORDER BY created_at DESC LIMIT 200`, params
  );
  res.json({ transactions: rows });
});

// ── Game histories ───────────────────────────────────────────────────────
router.get('/games/shooter', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, lobby_id, bet_amount, player_a_id, player_b_id, winner_id,
           status, result_reason, player_a_kills, player_b_kills, started_at, finished_at
      FROM shooter_sessions
  ORDER BY started_at DESC LIMIT 100
  `);
  res.json({ sessions: rows });
});
router.get('/games/rps', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, bet_amount, player_a_id, player_b_id, winner_id,
           status, player_a_score, player_b_score, started_at, finished_at
      FROM rps_matches
  ORDER BY started_at DESC LIMIT 100
  `);
  res.json({ matches: rows });
});
router.get('/games/roulette', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT user_id, bet_type, bet_value, bet_amount, result_number, result_color, payout, created_at
      FROM roulette_spins
  ORDER BY created_at DESC LIMIT 100
  `);
  res.json({ spins: rows });
});
router.get('/games/blackjack', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, user_id, bet_amount, status, outcome, payout, created_at, finished_at
      FROM blackjack_hands
  ORDER BY created_at DESC LIMIT 100
  `);
  res.json({ hands: rows });
});

// ── Admin recovery actions ───────────────────────────────────────────────
router.post('/shooter/cancel', async (req, res) => {
  try {
    const { matchId, reason } = req.body || {};
    await shooter.cancelShooterMatch(matchId, reason || 'admin_cancel');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/rps/cancel', async (req, res) => {
  try {
    const { matchId, reason } = req.body || {};
    await rps.cancelMatch(matchId, reason || 'admin_cancel');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Shooter replay / suspicious-match review ─────────────────────────────
router.get('/shooter/replays', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.shooter_match_id, e.session_id, e.suspicious_count,
             e.event_count, e.summary, e.created_at,
             ss.lobby_id, ss.bet_amount, ss.winner_id, ss.result_reason,
             ss.player_a_id, ss.player_b_id
        FROM shooter_match_events e
        JOIN shooter_sessions ss ON ss.id = e.shooter_match_id
    ORDER BY e.created_at DESC
       LIMIT 100
    `);
    res.json({ replays: rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/shooter/replays/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { rows } = await pool.query(
      `SELECT id, shooter_match_id, session_id, event_log, summary,
              suspicious_count, event_count, created_at
         FROM shooter_match_events
        WHERE shooter_match_id = $1
     ORDER BY created_at DESC LIMIT 1`,
      [matchId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ replay: rows[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/shooter/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.username, s.user_id, s.mmr, s.level, s.xp,
             s.total_matches, s.wins, s.losses, s.kills, s.deaths, s.headshots,
             s.current_win_streak, s.best_win_streak, s.last_match_at
        FROM shooter_player_stats s
        JOIN users u ON u.id = s.user_id
    ORDER BY s.mmr DESC
       LIMIT 100
    `);
    res.json({ leaderboard: rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/audit', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, actor_id, action, target_id, details, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ logs: rows });
});

module.exports = router;
