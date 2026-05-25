// server/games/shooter.js
// ============================================================================
//  Shooter game logic — extracted from the ORIGINAL root-level server.js so
//  the Three.js client (public/games/shooter.html) keeps working as-is.
//
//  Wallet integration: persistent escrow → win/refund through wallet.js.
//  Match state is still kept in-memory for the live tick loop, but every
//  monetary movement and the match result row are written to PostgreSQL.
// ============================================================================
require('dotenv').config();
const { withTx, pool } = require('../db');
const { adjustBalance } = require('../wallet');

// ── Constants (preserved from original server.js) ──────────────────────────
const MAX_HEALTH         = 100;
const KILLS_TO_WIN       = 5;
const MATCH_DURATION_MS  = 10 * 60 * 1000;
const RESPAWN_DELAY_MS   = 3000;
const LAG_COMP_BUFFER_MS = 600;
const PLAYER_HW          = 0.4;
const PLAYER_HEIGHT      = 1.8;
const MAX_MOVE_DELTA     = 2.5;
const HOUSE_FEE_PERCENT  = Math.min(50, Math.max(0, Number(process.env.HOUSE_FEE_PERCENT || 5)));

// Weapon configs — must mirror client's WEAPONS
const WEAPONS = {
  rifle:   { fireMs: 105,  mag: 30, dmg: 22, headDmg: 100, reloadMs: 2000, pellets: 1, spread: 0.0  },
  pistol:  { fireMs: 180,  mag: 12, dmg: 34, headDmg: 100, reloadMs: 1500, pellets: 1, spread: 0.0  },
  shotgun: { fireMs: 700,  mag: 6,  dmg: 16, headDmg: 60,  reloadMs: 2500, pellets: 6, spread: 0.10 },
  sniper:  { fireMs: 1500, mag: 5,  dmg: 50, headDmg: 100, reloadMs: 3500, pellets: 1, spread: 0.0  },
};
const DEFAULT_WEAPON = 'rifle';

// Persistent lobbies — same as before
const LOBBY_DEFS = [
  { id: 'bronze',  name: 'Bronze Arena',  bet: 50  },
  { id: 'silver',  name: 'Silver Pit',    bet: 100 },
  { id: 'gold',    name: 'Gold Vault',    bet: 250 },
  { id: 'diamond', name: 'Diamond Dome',  bet: 500 },
];

// ── In-memory live state ──────────────────────────────────────────────────
const lobbies = new Map();   // lobbyId   → { ...def, players:[socketId,..], mapVotes, status }
const matches = new Map();   // matchId   → live match state
const players = new Map();   // socketId  → { id, userId, username, currentLobby, currentMatch }

LOBBY_DEFS.forEach(def => lobbies.set(def.id, {
  id: def.id, name: def.name, bet: def.bet,
  players: [], mapVotes: {}, status: 'waiting',
}));

// ── Helpers ───────────────────────────────────────────────────────────────
function rayHitDistance(ray, box, maxDist = 80) {
  const { origin: o, direction: d } = ray;
  let tmin = 0, tmax = maxDist;
  for (const ax of ['x','y','z']) {
    if (Math.abs(d[ax]) < 1e-8) {
      if (o[ax] < box.min[ax] || o[ax] > box.max[ax]) return Infinity;
    } else {
      let t1 = (box.min[ax] - o[ax]) / d[ax];
      let t2 = (box.max[ax] - o[ax]) / d[ax];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}
const playerBox = (p) => ({
  min:{x:p.x-PLAYER_HW, y:p.y,      z:p.z-PLAYER_HW},
  max:{x:p.x+PLAYER_HW, y:p.y+1.45, z:p.z+PLAYER_HW},
});
const headBox = (p) => ({
  min:{x:p.x-0.22, y:p.y+1.45, z:p.z-0.22},
  max:{x:p.x+0.22, y:p.y+1.85, z:p.z+0.22},
});
function coverAabb(box) {
  const p = box.position, s = box.size;
  return {
    min: { x: p.x - s.w/2, y: p.y,       z: p.z - s.d/2 },
    max: { x: p.x + s.w/2, y: p.y + s.h, z: p.z + s.d/2 },
  };
}

function positionAtTime(history, ts) {
  if (!history?.length) return null;
  if (ts <= history[0].timestamp) return history[0].position;
  if (ts >= history[history.length-1].timestamp) return history[history.length-1].position;
  let lo = 0, hi = history.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].timestamp <= ts) lo = mid; else hi = mid;
  }
  const a = history[lo], b = history[hi];
  const t = (ts - a.timestamp) / (b.timestamp - a.timestamp);
  return {
    x: a.position.x + (b.position.x - a.position.x) * t,
    y: a.position.y + (b.position.y - a.position.y) * t,
    z: a.position.z + (b.position.z - a.position.z) * t,
  };
}

// ── Map generation — unchanged from original ──────────────────────────────
function symmetricalMap() {
  return [
    { position:{x:0,y:0,z:0},     size:{w:3,h:3,d:3}   },
    { position:{x:-8,y:0,z:0},    size:{w:1.5,h:3,d:6} },
    { position:{x:8,y:0,z:0},     size:{w:1.5,h:3,d:6} },
    { position:{x:-10,y:0,z:-10}, size:{w:3,h:3,d:3}   },
    { position:{x:10,y:0,z:-10},  size:{w:3,h:3,d:3}   },
    { position:{x:-10,y:0,z:10},  size:{w:3,h:3,d:3}   },
    { position:{x:10,y:0,z:10},   size:{w:3,h:3,d:3}   },
    { position:{x:-5,y:0,z:-13},  size:{w:4,h:3,d:1.5} },
    { position:{x:5,y:0,z:-13},   size:{w:4,h:3,d:1.5} },
    { position:{x:-5,y:0,z:13},   size:{w:4,h:3,d:1.5} },
    { position:{x:5,y:0,z:13},    size:{w:4,h:3,d:1.5} },
  ];
}
function randomMap() {
  const out = [];
  const n   = 6 + Math.floor(Math.random() * 3);
  const tries = 200;
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < tries; t++) {
      const w = 1.5 + Math.random() * 3;
      const d = 1.5 + Math.random() * 3;
      const x = (Math.random() - 0.5) * 30;
      const z = (Math.random() - 0.5) * 30;
      if (Math.abs(z - 17) < 6 || Math.abs(z + 17) < 6) continue;
      out.push({ position:{x,y:0,z}, size:{w,h:3,d} });
      break;
    }
  }
  return out;
}
function resolveMapType(votes) {
  const v = Object.values(votes).filter(Boolean);
  if (v.length === 0)                    return Math.random() < 0.5 ? 'symmetrical' : 'random';
  if (v.every(x => x === v[0]))          return v[0];
  return Math.random() < 0.5 ? 'symmetrical' : 'random';
}

function lobbySnapshot() {
  return LOBBY_DEFS.map(def => {
    const l = lobbies.get(def.id);
    return {
      id: l.id, name: l.name, bet: l.bet,
      playerCount: l.players.length, status: l.status,
    };
  });
}

// ── Wallet-aware match creation / closure ─────────────────────────────────

/** Deduct bets atomically and create shooter_sessions row. */
async function startShooterMatch(playerAUserId, playerBUserId, lobbyId, betAmount) {
  return withTx(async (client) => {
    const { rows: gs } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('shooter','active',$1,$2)
       RETURNING id`,
      [betAmount, betAmount * 2]
    );
    const sessionId = gs[0].id;

    // Per-player refId so both bet rows fit under the wallet's UNIQUE(ref_type, ref_id, reason) index
    await adjustBalance(playerAUserId, -betAmount, 'bet', { refType: 'shooter', refId: `${sessionId}:a`, client });
    await adjustBalance(playerBUserId, -betAmount, 'bet', { refType: 'shooter', refId: `${sessionId}:b`, client });

    const { rows } = await client.query(
      `INSERT INTO shooter_sessions
         (session_id, lobby_id, bet_amount, player_a_id, player_b_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [sessionId, lobbyId, betAmount, playerAUserId, playerBUserId]
    );
    return { matchId: rows[0].id, sessionId };
  });
}

/** Pay winner the pot (minus house fee). Idempotent via unique ledger index. */
async function finishShooterMatch(matchId, winnerUserId, reason = 'kills', stats = {}) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM shooter_sessions WHERE id = $1 FOR UPDATE`, [matchId]
    );
    if (!rows.length) throw new Error('shooter_match_not_found');
    const m = rows[0];
    if (m.status !== 'active') return { alreadyFinished: true };

    const bet = Number(m.bet_amount);
    const pot = bet * 2;
    const fee = Math.floor(pot * (HOUSE_FEE_PERCENT / 100));
    const payout = pot - fee;

    if (winnerUserId) {
      try {
        await adjustBalance(winnerUserId, payout, 'win', {
          refType: 'shooter', refId: m.session_id, client,
          metadata: { reason, fee, pot, ...stats },
        });
      } catch (e) {
        if (e.message !== 'duplicate_transaction') throw e;
      }
    } else {
      // No winner — refund both (per-player refId for uniqueness index)
      try {
        await adjustBalance(m.player_a_id, bet, 'refund',
          { refType: 'shooter', refId: `${m.session_id}:a`, client, metadata: { reason } });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
      try {
        await adjustBalance(m.player_b_id, bet, 'refund',
          { refType: 'shooter', refId: `${m.session_id}:b`, client, metadata: { reason } });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    }

    await client.query(
      `UPDATE shooter_sessions
          SET status='finished', winner_id=$1, result_reason=$2,
              player_a_kills = COALESCE($3, player_a_kills),
              player_b_kills = COALESCE($4, player_b_kills),
              finished_at = NOW()
        WHERE id = $5`,
      [winnerUserId || null, reason, stats.aKills ?? null, stats.bKills ?? null, matchId]
    );
    await client.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
      [m.session_id]
    );
    return { payout, fee };
  });
}

async function cancelShooterMatch(matchId, reason = 'cancelled') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM shooter_sessions WHERE id = $1 FOR UPDATE`, [matchId]
    );
    if (!rows.length) return;
    const m = rows[0];
    if (m.status !== 'active') return;
    const bet = Number(m.bet_amount);
    try {
      await adjustBalance(m.player_a_id, bet, 'refund', { refType: 'shooter', refId: `${m.session_id}:a`, client, metadata: { reason } });
    } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    try {
      await adjustBalance(m.player_b_id, bet, 'refund', { refType: 'shooter', refId: `${m.session_id}:b`, client, metadata: { reason } });
    } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
    await client.query(
      `UPDATE shooter_sessions SET status='cancelled', result_reason=$1, finished_at=NOW() WHERE id=$2`,
      [reason, matchId]
    );
    await client.query(
      `UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`,
      [m.session_id]
    );
  });
}

async function refundShooterMatch(matchId, reason = 'refund') {
  return cancelShooterMatch(matchId, reason);
}

module.exports = {
  // Constants / configs
  LOBBY_DEFS, MAX_HEALTH, KILLS_TO_WIN, MATCH_DURATION_MS, RESPAWN_DELAY_MS,
  LAG_COMP_BUFFER_MS, PLAYER_HW, PLAYER_HEIGHT, MAX_MOVE_DELTA, WEAPONS, DEFAULT_WEAPON,
  // Live state (used by shooterSocket.js)
  lobbies, matches, players,
  // Helpers
  rayHitDistance, playerBox, headBox, coverAabb, positionAtTime,
  symmetricalMap, randomMap, resolveMapType, lobbySnapshot,
  // Wallet-aware lifecycle
  startShooterMatch, finishShooterMatch, cancelShooterMatch, refundShooterMatch,
};
