// server/app.js — assembles the Express app (without HTTP listener)
require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const session  = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');

const { pool }       = require('./db');
const authRoutes     = require('./routes/authRoutes');
const walletRoutes   = require('./routes/walletRoutes');
const gameRoutes     = require('./routes/gameRoutes');
const adminRoutes    = require('./routes/adminRoutes');
const friendsRoutes  = require('./routes/friendsRoutes');
const cryptoRoutes   = require('./routes/cryptoRoutes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIO_DIR  = path.join(PUBLIC_DIR, 'assets', 'audio');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  // The app relies on inline scripts/styles + several CDNs, so a strict
  // script-src CSP isn't practical to retrofit safely. We still set the
  // directives that add protection WITHOUT restricting where scripts/styles
  // load from: no framing (clickjacking), no <object>/<embed> injection,
  // and a locked <base>/form target. (useDefaults:false → no default-src,
  // so scripts/styles/connect stay unrestricted and nothing breaks.)
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      // No default-src → scripts/styles/connect stay unrestricted (CDNs,
      // inline code and sockets keep working); we only add the safe guards.
      defaultSrc:        helmet.contentSecurityPolicy.dangerouslyDisableDefaultSrc,
      'frame-ancestors': ["'none'"],
      'object-src':      ["'none'"],
      'base-uri':        ["'self'"],
      'form-action':     ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },       // X-Frame-Options: DENY (older browsers)
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── CSRF defense-in-depth: same-origin guard for state-changing API calls ───
// Cookies are SameSite=lax (already blocks the cookie on cross-site POST), but
// we also reject any state-changing /api request whose Origin/Referer is a
// DIFFERENT host. A genuine cross-site CSRF attempt always carries a foreign
// Origin, so this stops it; same-origin XHR/fetch always sends a matching
// Origin, and the rare no-Origin case (non-browser clients) is allowed.
function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = req.headers.host;
  const allowedOrigin = process.env.CORS_ORIGIN || null;
  const origin = req.get('origin');
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return null; } };
  if (origin) {
    if (host && hostOf(origin) === host) return next();
    if (allowedOrigin && origin === allowedOrigin) return next();
    return res.status(403).json({ error: 'bad_origin' });
  }
  const ref = req.get('referer');
  if (ref) {
    if (host && hostOf(ref) === host) return next();
    if (allowedOrigin && hostOf(ref) === hostOf(allowedOrigin)) return next();
    return res.status(403).json({ error: 'bad_origin' });
  }
  return next();   // no Origin/Referer (non-browser client) — allow
}

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

// Sessions in PostgreSQL
const sessionMiddleware = session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // migrations create it
  }),
  name: 'fps.sid',
  secret: process.env.SESSION_SECRET || 'dev_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   1000 * 60 * 60 * 24 * 14, // 14 days
  },
});
app.use(sessionMiddleware);

// Global rate limit (gentle)
app.use(rateLimit({
  windowMs: 60 * 1000, max: 600,
  standardHeaders: true, legacyHeaders: false,
}));

// Per-route limiters — the global 600/min limiter above is fine for
// browsing, but game actions (spin / hit / reveal) and social writes
// (request / accept / chat) can be spammed by a malicious client to
// thrash the DB. Tighter limits stop a single IP from doing that
// without affecting normal play.
const gamesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,              // ~2/sec average — plenty for blackjack/mines bursts
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});
const friendsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,               // social writes — rarely needs more than 1/sec
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// Crypto endpoints touch an RPC node + the DB, so keep them on a tighter
// limiter than general browsing.
const cryptoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

// API routes — guarded against cross-origin state-changing requests.
app.use('/api', sameOriginGuard);
app.use('/api/auth',         authRoutes);
app.use('/api/wallet',       walletRoutes);
app.use('/api/games',        gamesLimiter, gameRoutes);
app.use('/api/admin/crypto', cryptoLimiter, cryptoRoutes.adminRouter);
app.use('/api/admin',        adminRoutes);
app.use('/api/friends',      friendsLimiter, friendsRoutes);
app.use('/api/crypto',       cryptoLimiter, cryptoRoutes.router);

// ── Audio endpoints (preserved from original shooter server.js) ─────────
// Anything that starts with one of these names is treated as a sound
// effect — kept out of the music playlist (/audio-files). gunshot_* are
// per-weapon overrides handled by the client AudioManager.
const SFX_RESERVED = /^(gunshot|footstep|jump|reload|hit|kill|menu)(\b|_)/i;

app.get('/audio-files', (_req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_DIR)
      .filter(f => /\.(mp3|ogg|wav|m4a|flac)$/i.test(f))
      .filter(f => !SFX_RESERVED.test(f));
    // If no non-reserved tracks, fall back to menu.wav so menu music still plays
    if (!files.length && fs.existsSync(path.join(AUDIO_DIR, 'menu.wav'))) {
      return res.json(['menu.wav']);
    }
    res.json(files);
  } catch (_) { res.json([]); }
});

app.get('/sfx-manifest', (_req, res) => {
  try {
    const all = fs.readdirSync(AUDIO_DIR);
    const find = (base) => all.find(f =>
      new RegExp(`^${base}\\.(mp3|ogg|wav|m4a|flac)$`, 'i').test(f)
    );
    res.json({
      // Generic / fallback gunshot — used when a per-weapon sound isn't present.
      gunshot:         find('gunshot')         || null,
      // Per-weapon variants. AudioManager loads each into its own buffer
      // and routes playShoot()/playSpatialShot() by weapon name.
      gunshot_rifle:   find('gunshot_rifle')   || null,
      gunshot_pistol:  find('gunshot_pistol')  || null,
      gunshot_shotgun: find('gunshot_shotgun') || null,
      gunshot_sniper:  find('gunshot_sniper')  || null,
      footstep:        find('footstep')        || null,
      reload:          find('reload')          || null,
      hit:             find('hit')             || null,
      kill:            find('kill')            || null,
    });
  } catch (_) { res.json({}); }
});

// Music files live at /audio/<filename>
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '7d' }));

// Static frontend
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 404 (API only — JSON)
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Custom 404 for any other unknown route — serve the themed page instead
// of Express's bare "Cannot GET /…" text. GET requests get the HTML page;
// other verbs get a short text body.
app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  }
  res.status(404).type('txt').send('Not found');
});

module.exports = { app, sessionMiddleware };
