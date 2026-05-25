// server/routes/gameRoutes.js — HTTP endpoints for roulette/blackjack + history
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const roulette  = require('../games/roulette');
const blackjack = require('../games/blackjack');
const { pool }  = require('../db');

const router = express.Router();

// ── ROULETTE ──────────────────────────────────────────────────────────────
router.post('/roulette/spin', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // Accept either { bets: [...] } (preferred) or single { betType, ... } (legacy)
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
    const { betAmount } = req.body || {};
    const hand = await blackjack.start(req.session.userId, betAmount);
    res.json({ ok: true, hand });
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
  const hand = await blackjack.getActive(req.session.userId);
  res.json({ hand });
});

module.exports = router;
