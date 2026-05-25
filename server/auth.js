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
    `SELECT u.id, u.username, u.is_admin, w.balance
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
    balance: Number(rows[0].balance || 0),
  };
}

module.exports = { register, login, currentUser, STARTING_CREDITS };
