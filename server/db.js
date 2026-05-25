// server/db.js — PostgreSQL connection pool + helpers
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL not set — set it in .env or environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', err => console.error('[db pool] unexpected error', err));

/** Run a parameterised query against the pool. */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Execute fn inside a PostgreSQL transaction with a dedicated client.
 * Commits on success, rolls back on error.
 */
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx };
