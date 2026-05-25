// server/migrate.js — run every .sql file in /migrations in order, once.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

(async () => {
  try {
    // Tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const f of files) {
      const { rows } = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1', [f]
      );
      if (rows.length) {
        console.log(`[migrate] skip   ${f} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(filename) VALUES ($1)', [f]
        );
        await client.query('COMMIT');
        console.log(`[migrate] apply  ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`[migrate] FAIL   ${f}:`, e.message);
        throw e;
      } finally {
        client.release();
      }
    }

    console.log('[migrate] done.');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
