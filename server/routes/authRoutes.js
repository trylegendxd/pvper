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

// Regenerate the session ID before associating it with the authenticated
// user — defeats session fixation (an attacker who planted a session cookie
// can't reuse it once the victim logs in). Promisified for async/await.
function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((err2) => err2 ? reject(err2) : resolve());
    });
  });
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.register(username, password);
    await establishSession(req, user.id);
    res.json({ ok: true, user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'register_failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.login(username, password);
    await establishSession(req, user.id);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'login_failed' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    // Cookie name must match the one configured in app.js ('fps.sid').
    // Clearing 'connect.sid' (the express-session default) left the real
    // cookie lingering in the browser after logout.
    res.clearCookie('fps.sid');
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
