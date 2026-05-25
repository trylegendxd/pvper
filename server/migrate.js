// server/migrate.js
// Exports runMigrations() so the server can call it on boot.
// Also runnable from CLI:   node server/migrate.js   or   npm run migrate
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations({ silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  for (const f of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1', [f]
    );
    if (rows.length) {
      log(`[migrate] skip   ${f} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      log(`[migrate] apply  ${f}`);
      appliedCount++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAIL   ${f}:`, e.message);
      throw e;
    } finally {
      client.release();
    }
  }
  return appliedCount;
}

// CLI entry
if (require.main === module) {
  runMigrations()
    .then(() => { console.log('[migrate] done.'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runMigrations };
