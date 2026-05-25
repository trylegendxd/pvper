// server/games/shooterRanking.js
// ============================================================================
//  Shooter Arena — ranking, MMR, XP, level, and lobby gating.
//
//  All formulas are in one place and intentionally simple, so they're easy
//  to tune later without touching gameplay code.
// ============================================================================
const { pool, withTx } = require('../db');

// ── Tuneables ──────────────────────────────────────────────────────────────
const DEFAULT_MMR     = 1000;
const ELO_K           = 32;
const MIN_MMR         = 100;
const MAX_MMR         = 4000;

// XP awards
const XP_BASE_PLAY    = 50;
const XP_WIN_BONUS    = 100;
const XP_PER_KILL     = 25;
const XP_PER_HEADSHOT = 10;

// Levels are derived from XP via an easy-to-tune curve:
//   level = 1 + floor( sqrt(xp / 100) )
// That gives: 100 xp → 2, 400 → 3, 900 → 4, 1600 → 5, 2500 → 6, ...
function levelFromXp(xp) {
  const x = Math.max(0, Number(xp) || 0);
  return 1 + Math.floor(Math.sqrt(x / 100));
}
function xpForLevel(level) {
  const L = Math.max(1, Number(level) || 1);
  return Math.pow(L - 1, 2) * 100;
}

// ── Lobby gating ───────────────────────────────────────────────────────────
// Kept intentionally permissive so dev/testing is not blocked.
// A player can enter a tier if EITHER condition is met (level OR matches OR mmr).
const LOBBY_REQUIREMENTS = {
  bronze:  { level: 1,  matches: 0,  mmr: 0,    label: 'Open to all' },
  silver:  { level: 3,  matches: 5,  mmr: 1050, label: 'Level 3 OR 5 matches OR 1050 MMR' },
  gold:    { level: 8,  matches: 20, mmr: 1200, label: 'Level 8 OR 20 matches OR 1200 MMR' },
  diamond: { level: 15, matches: 50, mmr: 1400, label: 'Level 15 OR 50 matches OR 1400 MMR' },
};

function requirementsFor(lobbyId) {
  return LOBBY_REQUIREMENTS[lobbyId] || LOBBY_REQUIREMENTS.bronze;
}

function meetsRequirementsFor(lobbyId, stats) {
  const req = requirementsFor(lobbyId);
  if (!stats) return req.level <= 1 && req.matches <= 0; // brand-new player ⇒ bronze only
  return (
    (stats.level         || 1) >= req.level   ||
    (stats.total_matches || 0) >= req.matches ||
    (stats.mmr           || DEFAULT_MMR) >= req.mmr
  );
}

// ── DB I/O ─────────────────────────────────────────────────────────────────

// Atomically fetch the user's stats row, creating a default one if missing.
async function getOrCreateStats(userId, client = null) {
  const runner = client || pool;
  // Upsert that does nothing on conflict, then a SELECT — keeps it simple.
  await runner.query(
    `INSERT INTO shooter_player_stats (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const { rows } = await runner.query(
    `SELECT user_id, mmr, level, xp, total_matches, wins, losses, kills, deaths,
            headshots, shots_fired, shots_hit, current_win_streak, best_win_streak,
            last_match_at, updated_at
       FROM shooter_player_stats WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}

// Read-only summary for the lobby UI — never throws.
async function publicStatsFor(userId) {
  try {
    const s = await getOrCreateStats(userId);
    return {
      mmr: s.mmr,
      level: s.level,
      xp: s.xp,
      xpForNext: xpForLevel((s.level || 1) + 1),
      totalMatches: s.total_matches,
      wins: s.wins,
      losses: s.losses,
      kills: s.kills,
      deaths: s.deaths,
      headshots: s.headshots,
      currentWinStreak: s.current_win_streak,
      bestWinStreak: s.best_win_streak,
    };
  } catch (_) { return null; }
}

// ── MMR math ───────────────────────────────────────────────────────────────
function expectedScore(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }
function clampMmr(n) { return Math.max(MIN_MMR, Math.min(MAX_MMR, Math.round(n))); }

// ── Match-result write ─────────────────────────────────────────────────────
// `winnerUserId === null` means draw / refund. Players get base XP only.
async function applyMatchResult({
  winnerUserId, loserUserId,
  winnerKills = 0, winnerHeadshots = 0, winnerShotsFired = 0, winnerShotsHit = 0,
  loserKills  = 0, loserHeadshots  = 0, loserShotsFired  = 0, loserShotsHit  = 0,
  draw = false,
}) {
  return withTx(async (client) => {
    const wStats = winnerUserId ? await getOrCreateStats(winnerUserId, client) : null;
    const lStats = loserUserId  ? await getOrCreateStats(loserUserId,  client) : null;

    let mmrW = wStats?.mmr ?? DEFAULT_MMR;
    let mmrL = lStats?.mmr ?? DEFAULT_MMR;
    let dW = 0, dL = 0;

    if (!draw && wStats && lStats) {
      const eW = expectedScore(mmrW, mmrL);
      const eL = 1 - eW;
      dW = Math.round(ELO_K * (1 - eW));
      dL = Math.round(ELO_K * (0 - eL));
      mmrW = clampMmr(mmrW + dW);
      mmrL = clampMmr(mmrL + dL);
    }

    // XP
    const winnerXp = draw
      ? XP_BASE_PLAY + XP_PER_KILL * winnerKills + XP_PER_HEADSHOT * winnerHeadshots
      : XP_BASE_PLAY + XP_WIN_BONUS + XP_PER_KILL * winnerKills + XP_PER_HEADSHOT * winnerHeadshots;
    const loserXp  = XP_BASE_PLAY + XP_PER_KILL * loserKills + XP_PER_HEADSHOT * loserHeadshots;

    const wOldLevel = wStats?.level ?? 1;
    const lOldLevel = lStats?.level ?? 1;
    const wNewXp = (wStats?.xp ?? 0) + winnerXp;
    const lNewXp = (lStats?.xp ?? 0) + loserXp;
    const wNewLevel = levelFromXp(wNewXp);
    const lNewLevel = levelFromXp(lNewXp);

    const result = {};

    if (wStats) {
      const newStreak = draw ? wStats.current_win_streak : (wStats.current_win_streak + 1);
      const bestStreak = Math.max(wStats.best_win_streak, newStreak);
      await client.query(
        `UPDATE shooter_player_stats SET
            mmr=$2, level=$3, xp=$4,
            total_matches = total_matches + 1,
            wins   = wins   + $5,
            losses = losses + 0,
            kills  = kills  + $6,
            headshots = headshots + $7,
            shots_fired = shots_fired + $8,
            shots_hit   = shots_hit   + $9,
            current_win_streak = $10,
            best_win_streak    = $11,
            last_match_at = NOW(),
            updated_at    = NOW()
         WHERE user_id = $1`,
        [winnerUserId, mmrW, wNewLevel, wNewXp,
         draw ? 0 : 1, winnerKills, winnerHeadshots, winnerShotsFired, winnerShotsHit,
         newStreak, bestStreak]
      );
      result.winner = {
        userId: winnerUserId,
        xpGained: winnerXp,
        mmrChange: mmrW - (wStats.mmr ?? DEFAULT_MMR),
        newMmr: mmrW,
        newXp: wNewXp,
        newLevel: wNewLevel,
        leveledUp: wNewLevel > wOldLevel,
      };
    }
    if (lStats) {
      await client.query(
        `UPDATE shooter_player_stats SET
            mmr=$2, level=$3, xp=$4,
            total_matches = total_matches + 1,
            losses = losses + $5,
            kills  = kills  + $6,
            deaths = deaths + 1,
            headshots = headshots + $7,
            shots_fired = shots_fired + $8,
            shots_hit   = shots_hit   + $9,
            current_win_streak = 0,
            last_match_at = NOW(),
            updated_at    = NOW()
         WHERE user_id = $1`,
        [loserUserId, mmrL, lNewLevel, lNewXp,
         draw ? 0 : 1, loserKills, loserHeadshots, loserShotsFired, loserShotsHit]
      );
      result.loser = {
        userId: loserUserId,
        xpGained: loserXp,
        mmrChange: mmrL - (lStats.mmr ?? DEFAULT_MMR),
        newMmr: mmrL,
        newXp: lNewXp,
        newLevel: lNewLevel,
        leveledUp: lNewLevel > lOldLevel,
      };
    }
    return result;
  });
}

module.exports = {
  DEFAULT_MMR, ELO_K,
  LOBBY_REQUIREMENTS, requirementsFor, meetsRequirementsFor,
  getOrCreateStats, publicStatsFor, applyMatchResult,
  levelFromXp, xpForLevel,
};
