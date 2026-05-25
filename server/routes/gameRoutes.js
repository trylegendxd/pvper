// server/routes/gameRoutes.js — HTTP endpoints for roulette/blackjack/mines + history
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const roulette  = require('../games/roulette');
const blackjack = require('../games/blackjack');
const mines     = require('../games/mines');
const ranking   = require('../games/shooterRanking');
const { pool }  = require('../db');

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

// Top-N leaderboard by MMR — capped, public to logged-in players.
router.get('/shooter/leaderboard', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.username, s.mmr, s.level, s.wins, s.losses, s.kills, s.deaths, s.total_matches
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
