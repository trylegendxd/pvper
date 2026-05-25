// server/games/shooterReplay.js
// ============================================================================
//  Lightweight, in-memory event recorder for Shooter matches.
//
//  Design goals:
//   * Zero DB writes during the match — events live in memory.
//   * One INSERT at match end with the whole event array as JSONB.
//   * Compact event shape — no per-frame state dumps.
//   * Movement is sampled (throttled), not every position update.
//   * Survives match cancellation / disconnect by being defensive about
//     missing recorders.
//
//  Killcam foundation:
//   Position snapshots + shot/hit/kill events give the server enough data
//   to reconstruct the last few seconds before a kill. The frontend can
//   later render a real killcam; for now a "Killcam data saved" placeholder
//   is shown in the post-match screen.
// ============================================================================
const { pool } = require('../db');

// Tuneable caps so a buggy/abusive client can't blow up memory.
const MAX_EVENTS_PER_MATCH = 12000;
const EVENT_OVERFLOW_DROP_OLDEST = true;

// recorders: matchId -> { sessionId, startedAt, events[], summary{}, lastMoveSnap{} }
const recorders = new Map();

function nowMs() { return Date.now(); }

function start(matchId, sessionId, meta = {}) {
  recorders.set(matchId, {
    sessionId,
    startedAt: nowMs(),
    events: [],
    summary: {
      players: meta.players || null,
      lobbyId: meta.lobbyId || null,
      mapType: meta.mapType || null,
      bet:     meta.bet     || null,
      suspicious: { count: 0, byType: {} },
    },
    lastMoveSnap: Object.create(null), // socketId -> timestamp ms
  });
  log(matchId, 'match_start', { sessionId, ...meta });
}

function log(matchId, type, data = {}) {
  const r = recorders.get(matchId);
  if (!r) return;
  const evt = { t: nowMs() - r.startedAt, type, ...data };
  if (r.events.length >= MAX_EVENTS_PER_MATCH) {
    if (EVENT_OVERFLOW_DROP_OLDEST) r.events.shift();
    else return;
  }
  r.events.push(evt);
  if (type === 'suspicious_action_rejected') {
    r.summary.suspicious.count++;
    const k = data.reason || 'unknown';
    r.summary.suspicious.byType[k] = (r.summary.suspicious.byType[k] || 0) + 1;
  }
}

// Movement snapshot — throttled. Returns true if the snapshot was recorded.
// `rotation` is optional but used by the killcam to reconstruct POV.
function maybeMoveSnapshot(matchId, socketId, position, intervalMs, rotation) {
  const r = recorders.get(matchId);
  if (!r) return false;
  const last = r.lastMoveSnap[socketId] || 0;
  const t = nowMs();
  if (t - last < intervalMs) return false;
  r.lastMoveSnap[socketId] = t;
  const evt = {
    s: socketId,
    p: [
      Math.round(position.x * 100) / 100,
      Math.round(position.y * 100) / 100,
      Math.round(position.z * 100) / 100,
    ],
  };
  if (rotation && typeof rotation.y === 'number') {
    evt.r = [
      Math.round((rotation.x || 0) * 1000) / 1000,
      Math.round((rotation.y || 0) * 1000) / 1000,
    ];
  }
  log(matchId, 'movement', evt);
  return true;
}

// Pull the last `windowMs` of events for a specific player (the killer), used
// to build a killcam packet sent to the victim. Returns events with their
// relative timestamps (`t`) preserved so the client can replay at real time.
function getRecentForKillcam(matchId, killerSocketId, windowMs = 3000) {
  const r = recorders.get(matchId);
  if (!r) return null;
  const cutoff = (r.events.length ? r.events[r.events.length - 1].t : 0) - windowMs;
  const out = [];
  for (let i = r.events.length - 1; i >= 0; i--) {
    const e = r.events[i];
    if (e.t < cutoff) break;
    // Only include events for the killer's POV (movement, shots, hits, kill).
    if (e.s && e.s !== killerSocketId && e.type !== 'kill') continue;
    if (e.type === 'kill' && e.killer !== killerSocketId) continue;
    out.unshift(e);
  }
  return out;
}

function getSuspiciousCount(matchId) {
  const r = recorders.get(matchId);
  return r ? r.summary.suspicious.count : 0;
}

// Flush the in-memory buffer to a single DB row, then drop it.
// Returns the inserted row id (or null if nothing to flush).
async function flush(matchId, dbMatchId, extraSummary = {}) {
  const r = recorders.get(matchId);
  if (!r) return null;
  recorders.delete(matchId);

  const summary = { ...r.summary, ...extraSummary };
  try {
    const { rows } = await pool.query(
      `INSERT INTO shooter_match_events
         (shooter_match_id, session_id, event_log, summary,
          suspicious_count, event_count)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        dbMatchId,
        r.sessionId,
        JSON.stringify(r.events),
        JSON.stringify(summary),
        summary.suspicious?.count || 0,
        r.events.length,
      ]
    );
    return rows[0]?.id || null;
  } catch (e) {
    // Replay logging must never break a match — log and move on.
    console.error('[shooter-replay] flush failed:', e.message);
    return null;
  }
}

// Drop the buffer without writing (e.g. cancelled before start).
function discard(matchId) { recorders.delete(matchId); }

module.exports = {
  start, log, maybeMoveSnapshot, getRecentForKillcam,
  flush, discard, getSuspiciousCount,
  MAX_EVENTS_PER_MATCH,
};
