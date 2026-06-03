// server/auth.js — register / login / logout backed by sessions
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool, withTx } = require('./db');

const STARTING_CREDITS = Math.max(0, Number(process.env.STARTING_CREDITS || 1000));
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

async function register(username, password) {
  if (!USERNAME_RE.test(username)) {
    const err = new Error('invalid_username'); err.status = 400; throw err;
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    const err = new Error('invalid_password'); err.status = 400; throw err;
  }

  const hash = await bcrypt.hash(password, 12);

  return withTx(async (client) => {
    // Case-insensitive uniqueness
    const exists = await client.query(
      'SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]
    );
    if (exists.rows.length) {
      const err = new Error('username_taken'); err.status = 409; throw err;
    }

    const isAdmin = ADMIN_IDS.has(username.toLowerCase()); // also allow username-based admin bootstrap

    const { rows: urows } = await client.query(
      `INSERT INTO users (username, password_hash, is_admin)
       VALUES ($1, $2, $3)
       RETURNING id, username, is_admin, created_at`,
      [username, hash, isAdmin]
    );
    const user = urows[0];

    // Create wallet with starting credits
    await client.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2)',
      [user.id, STARTING_CREDITS]
    );
    if (STARTING_CREDITS > 0) {
      await client.query(
        `INSERT INTO wallet_transactions
           (user_id, amount, balance_after, reason)
         VALUES ($1, $2, $2, 'signup_bonus')`,
        [user.id, STARTING_CREDITS]
      );
    }

    // Promote if user id appears in ADMIN_USER_IDS (UUID form)
    if (ADMIN_IDS.has(user.id)) {
      await client.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
      user.is_admin = true;
    }
    return user;
  });
}

async function login(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    const err = new Error('invalid_credentials'); err.status = 401; throw err;
  }
  const { rows } = await pool.query(
    `SELECT id, username, password_hash, is_admin
       FROM users
      WHERE lower(username) = lower($1)`,
    [username]
  );
  if (!rows.length) {
    const err = new Error('invalid_credentials'); err.status = 401; throw err;
  }
  const u = rows[0];
  const ok = await bcrypt.compare(password || '', u.password_hash);
  if (!ok) {
    const err = new Error('invalid_credentials'); err.status = 401; throw err;
  }

  // ENV-based admin promotion (UUID form)
  let isAdmin = !!u.is_admin;
  if (!isAdmin && ADMIN_IDS.has(u.id)) {
    await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [u.id]);
    isAdmin = true;
  }

  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [u.id]);

  return { id: u.id, username: u.username, is_admin: isAdmin };
}

async function currentUser(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.is_admin, u.display_name, u.avatar, u.bio, w.balance
       FROM users u
  LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    username: rows[0].username,
    is_admin: !!rows[0].is_admin,
    display_name: rows[0].display_name || null,
    avatar: rows[0].avatar || null,
    bio: rows[0].bio || null,
    balance: Number(rows[0].balance || 0),
  };
}

// Patch the editable profile fields. Returns the updated currentUser
// snapshot. Strict validation: display_name length, bio length, avatar
// size (~200 KB after base64). Each field is optional — only the keys
// supplied in `updates` are touched.
async function updateProfile(userId, updates = {}) {
  if (!userId) {
    const err = new Error('not_authenticated'); err.status = 401; throw err;
  }
  const setClauses = [];
  const values = [];
  const push = (col, val) => {
    values.push(val);
    setClauses.push(`${col} = $${values.length}`);
  };

  if (updates.display_name !== undefined) {
    if (updates.display_name === null || updates.display_name === '') {
      push('display_name', null);
    } else {
      const dn = String(updates.display_name).trim();
      if (dn.length < 1 || dn.length > 32) {
        const e = new Error('invalid_display_name'); e.status = 400; throw e;
      }
      push('display_name', dn);
    }
  }
  if (updates.bio !== undefined) {
    if (updates.bio === null || updates.bio === '') {
      push('bio', null);
    } else {
      const b = String(updates.bio);
      if (b.length > 280) {
        const e = new Error('invalid_bio'); e.status = 400; throw e;
      }
      push('bio', b);
    }
  }
  if (updates.avatar !== undefined) {
    if (updates.avatar === null || updates.avatar === '') {
      push('avatar', null);
    } else {
      const a = String(updates.avatar);
      // Must be a data URL — anything else (remote URL etc) is rejected
      // so the rendering side stays free of CORS / SSRF concerns.
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(a)) {
        const e = new Error('invalid_avatar_format'); e.status = 400; throw e;
      }
      // Cap at ~270 KB of base64 (≈ 200 KB binary). Anything larger is
      // almost certainly an unscaled phone photo.
      if (a.length > 270 * 1024) {
        const e = new Error('avatar_too_large'); e.status = 413; throw e;
      }
      push('avatar', a);
    }
  }

  if (!setClauses.length) return currentUser(userId);

  values.push(userId);
  await pool.query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
    values
  );
  return currentUser(userId);
}

module.exports = { register, login, currentUser, updateProfile, STARTING_CREDITS };
