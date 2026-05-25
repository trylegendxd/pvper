// server/routes/walletRoutes.js
const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const wallet = require('../wallet');

const router = express.Router();

router.get('/balance', requireAuth, async (req, res) => {
  const balance = await wallet.getBalance(req.session.userId);
  res.json({ balance });
});

router.get('/history', requireAuth, async (req, res) => {
  const history = await wallet.getHistory(req.session.userId, req.query.limit);
  res.json({ history });
});

module.exports = router;
