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

// Edit the player's own profile — display name, avatar (data URL),
// bio. Express body limit is 100 KB by default in app.js; raise it
// locally for this route so an avatar fits.
router.patch('/me', express.json({ limit: '300kb' }), async (req, res) => {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: 'not_authenticated' });
    const updated = await auth.updateProfile(req.session.userId, req.body || {});
    res.json({ ok: true, user: updated });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'update_failed' });
  }
});

module.exports = router;
