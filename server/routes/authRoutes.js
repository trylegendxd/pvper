// server/routes/authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.register(username, password);
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'register_failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.login(username, password);
    req.session.userId = user.id;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'login_failed' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  const me = await auth.currentUser(req.session.userId);
  res.json({ user: me });
});

module.exports = router;
