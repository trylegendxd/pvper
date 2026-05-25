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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIO_DIR  = path.join(PUBLIC_DIR, 'assets', 'audio');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,        // Three.js CDN + inline shooter script
  crossOriginEmbedderPolicy: false,
}));

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

// API routes
app.use('/api/auth',    authRoutes);
app.use('/api/wallet',  walletRoutes);
app.use('/api/games',   gameRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/friends', friendsRoutes);

// ── Audio endpoints (preserved from original shooter server.js) ─────────
const SFX_RESERVED = /^(gunshot|footstep|jump|reload|hit|kill|menu)\b/i;

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
      gunshot:  find('gunshot')  || null,
      footstep: find('footstep') || null,
      reload:   find('reload')   || null,
      hit:      find('hit')      || null,
      kill:     find('kill')     || null,
    });
  } catch (_) { res.json({}); }
});

// Music files live at /audio/<filename>
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '7d' }));

// Static frontend
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 404 (API only — HTML routes fall through to static)
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

module.exports = { app, sessionMiddleware };
