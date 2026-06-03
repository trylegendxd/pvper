// server/games/shooterAchievements.js
// ============================================================================
//  Shooter achievement detection + grant.
//
//  The keys here must mirror the rows seeded by migrations/006_achievements.sql.
//  At runtime we never INSERT into the catalog — only into user_achievements,
//  and we always use ON CONFLICT DO NOTHING so a duplicate grant is a no-op.
//
//  Two entry points:
//    * grantOne(userId, key)               — fire-and-forget at kill time
//    * detectMatchEnd(ctx)                 — post-match scan, returns the
//                                            list of newly-earned definitions
//
//  Both return the full achievement row(s) that were *newly* earned, so the
//  caller can ship them in match_end / a live socket event for the toast UI.
// ============================================================================
const { pool } = require('../db');

const KEYS = Object.freeze({
  FIRST_KILL:      'first_kill',
  FIRST_HEADSHOT:  'first_headshot',
  KILLING_SPREE:   'killing_spree',
  RAMPAGE:         'rampage',
  WALL_BANGER:     'wall_banger',
  COLD_STEEL:      'cold_steel',
  ONE_PUMP:        'one_pump',
  FLAWLESS:        'flawless',
  HEADSHOT_MACHINE:'headshot_machine',
  FIRST_WIN:       'first_win',
  STREAK_5:        'streak_5',
  STREAK_10:       'streak_10',
  LEVEL_5:         'level_5',
  LEVEL_10:        'level_10',
  LEVEL_20:        'level_20',
  MATCHES_10:      'matches_10',
  MATCHES_100:     'matches_100',
});

// Granted achievements are cached in-memory per process so the at-kill
// grants don't have to round-trip the DB to check if the user already
// has an achievement. Misses fall through to the DB; writes update both.
// Eviction is by simple LRU after MAX_CACHE entries.
const _ownedCache = new Map();  // userId → Set<key>
const MAX_CACHE = 5000;

function _cacheTouch(userId) {
  // Reinsert at the tail so Map iteration order acts as recent-first.
  const s = _ownedCache.get(userId);
  if (s) { _ownedCache.delete(userId); _ownedCache.set(userId, s); }
  return s;
}

async function _loadOwned(userId) {
  let s = _cacheTouch(userId);
  if (s) return s;
  s = new Set();
  try {
    const { rows } = await pool.query(
      `SELECT a.key FROM user_achievements ua
         JOIN achievements a ON a.id = ua.achievement_id
        WHERE ua.user_id = $1`, [userId]
    );
    for (const r of rows) s.add(r.key);
  } catch (_) { /* table may be missing pre-migration — treat as empty */ }
  _ownedCache.set(userId, s);
  while (_ownedCache.size > MAX_CACHE) {
    const first = _ownedCache.keys().next().value;
    _ownedCache.delete(first);
  }
  return s;
}

// Grant a single achievement. Returns the full row if it was a fresh
// grant, or null when the user already had it.
async function grantOne(userId, key) {
  if (!userId || !key) return null;
  const owned = await _loadOwned(userId);
  if (owned.has(key)) return null;
  try {
    const { rows: defs } = await pool.query(
      `SELECT id, key, name, description, icon, category FROM achievements WHERE key = $1`,
      [key]
    );
    if (!defs.length) return null;
    const def = defs[0];
    const { rowCount } = await pool.query(
      `INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, def.id]
    );
    if (!rowCount) { owned.add(key); return null; }
    owned.add(key);
    return def;
  } catch (e) {
    // Migration may not have run yet; don't blow up the kill flow.
    return null;
  }
}

// Convenience — grant many in parallel and only return the ones that
// were actually new.
async function grantMany(userId, keys) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const results = await Promise.all(keys.map(k => grantOne(userId, k)));
  return results.filter(Boolean);
}

// Post-match achievement scan. ctx = {
//   userId, isWinner, matchStats (per-player), liveStats (post-match profile snapshot)
// }
async function detectMatchEnd(ctx) {
  const { userId, isWinner, matchStats, liveStats } = ctx;
  const candidates = [];

  if ((matchStats?.kills || 0) >= 1)      candidates.push(KEYS.FIRST_KILL);
  if ((matchStats?.headshots || 0) >= 1)  candidates.push(KEYS.FIRST_HEADSHOT);
  if ((matchStats?.headshots || 0) >= 5)  candidates.push(KEYS.HEADSHOT_MACHINE);
  if (isWinner && (matchStats?.deaths || 0) === 0 && (matchStats?.kills || 0) > 0) {
    candidates.push(KEYS.FLAWLESS);
  }
  if (isWinner) candidates.push(KEYS.FIRST_WIN);

  if ((liveStats?.currentWinStreak || 0) >= 5)  candidates.push(KEYS.STREAK_5);
  if ((liveStats?.currentWinStreak || 0) >= 10) candidates.push(KEYS.STREAK_10);
  if ((liveStats?.level || 1) >= 5)  candidates.push(KEYS.LEVEL_5);
  if ((liveStats?.level || 1) >= 10) candidates.push(KEYS.LEVEL_10);
  if ((liveStats?.level || 1) >= 20) candidates.push(KEYS.LEVEL_20);
  if ((liveStats?.totalMatches || 0) >= 10)  candidates.push(KEYS.MATCHES_10);
  if ((liveStats?.totalMatches || 0) >= 100) candidates.push(KEYS.MATCHES_100);

  return grantMany(userId, candidates);
}

// Read all achievements + earned timestamps for a single user. Locked
// rows have earned_at = null.
async function listForUser(userId) {
  try {
    const { rows } = await pool.query(`
      SELECT a.key, a.name, a.description, a.icon, a.category, a.sort_order,
             ua.earned_at
        FROM achievements a
   LEFT JOIN user_achievements ua
          ON ua.achievement_id = a.id AND ua.user_id = $1
    ORDER BY a.sort_order, a.id`, [userId]);
    return rows;
  } catch (_) { return []; }
}

module.exports = { KEYS, grantOne, grantMany, detectMatchEnd, listForUser };
