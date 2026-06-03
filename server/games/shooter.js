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

// ── Server-authoritative tuneables ─────────────────────────────────────────
// All deliberately a little generous so average-ping players are never
// punished. Reject only what is clearly impossible.
const MAX_MOVE_SPEED_UPS        = 14;     // units/sec — sprint ~6, this allows lag-burst spikes
const MAX_ACCEL_UPS2            = 80;     // per-second velocity delta cap
const MAX_LAG_COMP_MS           = 600;    // never rewind further than this (mirrors LAG_COMP_BUFFER_MS)
const MAX_CLIENT_TIME_DRIFT_MS  = 2500;   // |clientTs - serverTs|
const WEAPON_SWITCH_COOLDOWN_MS = 250;    // can't switch faster than this
const SHOT_AFTER_SWITCH_MS      = 180;    // can't fire immediately after switching
const POSITION_HISTORY_MS       = 1500;   // how far back we keep position history
const MOVEMENT_SNAPSHOT_INTERVAL_MS = 200; // replay-log throttle for movement
const MAX_SUSPICIOUS_SCORE      = 50;     // soft cap — not auto-banned, only logged
const MAX_SHOT_DIRECTION_DEVIATION = 0.6; // dot-product floor between shot dir and look dir

// Weapon configs — must mirror client's WEAPONS
const WEAPONS = {
  rifle:   { fireMs: 105,  mag: 30,  dmg: 22, headDmg: 100, reloadMs: 2000, pellets: 1, spread: 0.0,  melee: false, maxRange: 80 },
  pistol:  { fireMs: 180,  mag: 12,  dmg: 34, headDmg: 100, reloadMs: 1500, pellets: 1, spread: 0.0,  melee: false, maxRange: 80 },
  shotgun: { fireMs: 700,  mag: 6,   dmg: 16, headDmg: 60,  reloadMs: 2500, pellets: 6, spread: 0.10, melee: false, maxRange: 80 },
  sniper:  { fireMs: 1500, mag: 5,   dmg: 50, headDmg: 100, reloadMs: 3500, pellets: 1, spread: 0.0,  melee: false, maxRange: 80 },
  // Knife is a melee weapon: infinite "ammo", short reach. The server
  // rejects any hit beyond maxRange so it can't be used like a free
  // hitscan gun.
  knife:   { fireMs: 500,  mag: 999, dmg: 55, headDmg: 80,  reloadMs: 0,    pellets: 1, spread: 0.0,  melee: true,  maxRange: 2.2 },
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
// Private (host-created) lobbies — separate from the public arena lobbies
// so they can't collide with bronze/silver/gold/diamond IDs.
//
//   privateId → {
//     id, inviteCode, hostUserId, hostSocketId,
//     teamSize (1|2|3|5), maxPlayers, mode ('duel'|'team'),
//     bet, weaponMode, killsToWin,
//     members: [{ socketId, userId, username, team, ready, connected }],
//     invitedUserIds: Set<userId>,
//     status: 'waiting' | 'ready' | 'starting' | 'in_progress' | 'disbanded',
//     createdAt
//   }
const privateLobbies = new Map();
// Invite-code lookup for short join codes (case-insensitive).
const privateLobbiesByCode = new Map();

LOBBY_DEFS.forEach(def => lobbies.set(def.id, {
  id: def.id, name: def.name, bet: def.bet,
  players: [], mapVotes: {}, modeVotes: {}, roundsVotes: {},
  status: 'waiting',
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
// Thin cover (railings, fence walls, partition boards) is considered
// penetrable — bullets pass through at reduced damage. A box is "thin"
// when either of its horizontal dimensions is below the threshold,
// which catches things like a 9 × 0.25 catwalk railing or a 0.5 × 8
// fence without affecting solid crates / shipping containers.
const COVER_PENETRABLE_MIN = 0.7;
const COVER_PENETRATION_DAMAGE_MULT = 0.5;

function coverAabb(box) {
  const p = box.position, s = box.size;
  return {
    min: { x: p.x - s.w/2, y: p.y,       z: p.z - s.d/2 },
    max: { x: p.x + s.w/2, y: p.y + s.h, z: p.z + s.d/2 },
    penetrable: Math.min(s.w, s.d) < COVER_PENETRABLE_MIN,
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

// ── Depot — bigger CS-style tactical layout ────────────────────────────
// 70x70 arena with a long lane (west), a short connector (east),
// a warehouse interior (north/south), central yard cover, and dedicated
// spawn cover for both teams.
function csDepotMap() {
  return [
    // CENTRAL YARD COVER
    { position:{x:0, y:0, z:0},  size:{w:6, h:3.0, d:3} },
    { position:{x:-8, y:0, z:2}, size:{w:3, h:2.2, d:3} },
    { position:{x:8, y:0, z:-2}, size:{w:3, h:2.2, d:3} },
    { position:{x:-3.5, y:0, z:8},  size:{w:3, h:1.4, d:2} },
    { position:{x:3.5, y:0, z:-8}, size:{w:3, h:1.4, d:2} },

    // LONG LANE — left/west side
    { position:{x:-22, y:0, z:0},   size:{w:2.2, h:3.0, d:28} },
    { position:{x:-14, y:0, z:14},  size:{w:3, h:2.5, d:5} },
    { position:{x:-14, y:0, z:-14}, size:{w:3, h:2.5, d:5} },
    { position:{x:-27, y:0, z:12},  size:{w:3, h:1.6, d:3} },
    { position:{x:-27, y:0, z:-12}, size:{w:3, h:1.6, d:3} },
    { position:{x:-27, y:0, z:0},   size:{w:3, h:2.2, d:4} },

    // SHORT / RIGHT ROUTE — east side
    { position:{x:21, y:0, z:8},   size:{w:3, h:3.0, d:14} },
    { position:{x:21, y:0, z:-8},  size:{w:3, h:3.0, d:14} },
    { position:{x:29, y:0, z:16},  size:{w:4, h:2.0, d:4} },
    { position:{x:29, y:0, z:-16}, size:{w:4, h:2.0, d:4} },
    { position:{x:14, y:0, z:0},   size:{w:4, h:2.5, d:4} },

    // WAREHOUSE WALLS — long horizontal blocks framing the interior route
    { position:{x:-8, y:0, z:24},  size:{w:16, h:3.2, d:2} },
    { position:{x:8, y:0, z:24},   size:{w:10, h:3.2, d:2} },
    { position:{x:-8, y:0, z:-24}, size:{w:10, h:3.2, d:2} },
    { position:{x:8, y:0, z:-24},  size:{w:16, h:3.2, d:2} },

    // Interior crates / warehouse approach
    { position:{x:-4, y:0, z:18},  size:{w:4, h:2.0, d:3} },
    { position:{x:5,  y:0, z:18},  size:{w:3, h:1.5, d:3} },
    { position:{x:-5, y:0, z:-18}, size:{w:3, h:1.5, d:3} },
    { position:{x:4,  y:0, z:-18}, size:{w:4, h:2.0, d:3} },

    // SPAWN COVER — both team sides
    { position:{x:0, y:0, z:29},    size:{w:7, h:2.4, d:2.5} },
    { position:{x:-10, y:0, z:30},  size:{w:4, h:2.2, d:3} },
    { position:{x:10, y:0, z:30},   size:{w:4, h:2.2, d:3} },
    { position:{x:0, y:0, z:-29},   size:{w:7, h:2.4, d:2.5} },
    { position:{x:-10, y:0, z:-30}, size:{w:4, h:2.2, d:3} },
    { position:{x:10, y:0, z:-30},  size:{w:4, h:2.2, d:3} },

    // SITE-LIKE CORNERS / EXTRA PLAY AREAS
    { position:{x:-30, y:0, z:25}, size:{w:5, h:2.5, d:5} },
    { position:{x:-23, y:0, z:25}, size:{w:3, h:1.4, d:4} },
    { position:{x:30, y:0, z:-25}, size:{w:5, h:2.5, d:5} },
    { position:{x:23, y:0, z:-25}, size:{w:3, h:1.4, d:4} },

    // EXTRA CONTAINER CLUTTER
    { position:{x:-17, y:0, z:5},  size:{w:3, h:1.8, d:6} },
    { position:{x:17, y:0, z:-5},  size:{w:3, h:1.8, d:6} },
    { position:{x:-2, y:0, z:14},  size:{w:2, h:1.2, d:5} },
    { position:{x:2, y:0, z:-14},  size:{w:2, h:1.2, d:5} },

    // ── CATWALK STAIRCASE A (north side, mid-west) ─────────────────
    // Four climbable steps lead up to a 2m-tall catwalk that overlooks
    // the central yard. Each step is 0.5m tall and 1.5m wide so the
    // client-side step-up logic (STEP_UP_MAX = 0.7m) lets the player
    // walk up them naturally.
    { position:{x:-12, y:0, z:9},   size:{w:1.8, h:0.5,  d:1.5} },  // step 1
    { position:{x:-12, y:0, z:7.5}, size:{w:1.8, h:1.0,  d:1.5} },  // step 2
    { position:{x:-12, y:0, z:6},   size:{w:1.8, h:1.5,  d:1.5} },  // step 3
    { position:{x:-12, y:0, z:4.5}, size:{w:1.8, h:2.0,  d:1.5} },  // step 4 / platform edge
    // The catwalk itself (8m long elevated platform).
    { position:{x:-7,  y:0, z:4.5}, size:{w:9, h:2.0,  d:2}   },
    // Wooden guard rail along the inner edge of the catwalk so you
    // can take cover up there.
    { position:{x:-7,  y:0, z:3.3}, size:{w:9, h:2.6,  d:0.25} },

    // ── CATWALK STAIRCASE B (south-east mirror) ────────────────────
    { position:{x:12,  y:0, z:-9},   size:{w:1.8, h:0.5,  d:1.5} },
    { position:{x:12,  y:0, z:-7.5}, size:{w:1.8, h:1.0,  d:1.5} },
    { position:{x:12,  y:0, z:-6},   size:{w:1.8, h:1.5,  d:1.5} },
    { position:{x:12,  y:0, z:-4.5}, size:{w:1.8, h:2.0,  d:1.5} },
    { position:{x:7,   y:0, z:-4.5}, size:{w:9, h:2.0,  d:2}   },
    { position:{x:7,   y:0, z:-3.3}, size:{w:9, h:2.6,  d:0.25} },

    // ── BIG SHIPPING CONTAINER (climbable cube near long lane) ────
    // 0.6m kick-up step + the container body. You can hop up the step
    // and use the container as an elevated sniper perch over long.
    { position:{x:-18, y:0, z:-2},   size:{w:1.5, h:0.6, d:1.5} },
    { position:{x:-16, y:0, z:-3},   size:{w:3.5, h:2.4, d:5}   },

    // ── LOW STACKED CRATES near the warehouse openings ────────────
    // Pairs of half-height crates that the player can step on, but
    // still provide cover from incoming fire.
    { position:{x:-3,  y:0, z:22},   size:{w:1.5, h:0.6, d:1.5} },
    { position:{x:3,   y:0, z:22},   size:{w:1.5, h:0.6, d:1.5} },
    { position:{x:-3,  y:0, z:-22},  size:{w:1.5, h:0.6, d:1.5} },
    { position:{x:3,   y:0, z:-22},  size:{w:1.5, h:0.6, d:1.5} },

    // ── RAMP RUN (south-west) — three quarter-steps, walk straight up ─
    { position:{x:-19, y:0, z:18},   size:{w:3, h:0.4, d:1.8} },
    { position:{x:-19, y:0, z:16.2}, size:{w:3, h:0.8, d:1.8} },
    { position:{x:-19, y:0, z:14.4}, size:{w:3, h:1.2, d:1.8} },
  ];
}

// Map of mapType → { mapType, mapName, arenaSize, coverBoxes, spawnPoints }.
// Adding a new map only needs an entry here and a vote button on the
// client. The match start path reads everything else dynamically.
function buildMapByType(mapType) {
  if (mapType === 'cs_depot') return {
    mapType: 'cs_depot',
    mapName: 'Depot',
    arenaSize: 70,
    coverBoxes: csDepotMap(),
    spawnPoints: [ { x: 0, y: 0, z: 31 }, { x: 0, y: 0, z: -31 } ],
  };
  if (mapType === 'random') return {
    mapType: 'random',
    mapName: 'Random',
    arenaSize: 40,
    coverBoxes: randomMap(),
    spawnPoints: [ { x: 0, y: 0, z: 17 }, { x: 0, y: 0, z: -17 } ],
  };
  return {
    mapType: 'symmetrical',
    mapName: 'Symmetrical',
    arenaSize: 40,
    coverBoxes: symmetricalMap(),
    spawnPoints: [ { x: 0, y: 0, z: 17 }, { x: 0, y: 0, z: -17 } ],
  };
}

// All valid map vote values. Keep in sync with vote_map socket handler
// and the frontend voting buttons.
const MAP_TYPES = ['symmetrical', 'random', 'cs_depot'];

function resolveMapType(votes) {
  const v = Object.values(votes).filter(x => MAP_TYPES.includes(x));
  if (v.length === 0) {
    // Random pick across all known maps when nobody votes.
    return MAP_TYPES[Math.floor(Math.random() * MAP_TYPES.length)];
  }
  if (v.every(x => x === v[0])) return v[0];
  // Disagreement → random pick from the votes that WERE cast.
  return v[Math.floor(Math.random() * v.length)];
}

// Allowed weapon modes for lobby vote.
const WEAPON_MODES = ['all','rifle','pistol','shotgun','sniper'];
function resolveWeaponMode(votes) {
  const v = Object.values(votes || {}).filter(x => WEAPON_MODES.includes(x));
  if (v.length === 0)              return 'all';
  if (v.every(x => x === v[0]))    return v[0];
  return v[Math.floor(Math.random() * v.length)];
}

// Rounds = first-to-N kills. Allowed: 3 / 5 / 7. Default 5.
const ROUND_OPTIONS = [3, 5, 7];

// Allowed team sizes for private lobbies. The number is the team count
// per side, so 2 = 2v2, 3 = 3v3, 5 = 5v5. 1 = classic 1v1.
const TEAM_SIZES = [1, 2, 3, 5];

// ── Throwables (Molotov + Smoke) ──────────────────────────────────────
// All values in one place so they're easy to tune later. Conservative
// defaults aimed at NOT being overpowered in 1v1.
const THROWABLE_CONFIG = {
  molotov: {
    count: 1,                 // per life
    cooldownMs: 1200,
    throwSpeed: 16,           // m/s muzzle speed (gives a nice arc)
    gravity: 18,              // m/s² downward
    maxFlightMs: 4000,
    area: {
      radius: 3.2,
      durationMs: 7000,
      tickIntervalMs: 500,
      tickDamage: 10,         // per tick (so ~20 dmg/sec)
      friendlyFire: false,
    },
  },
  smoke: {
    count: 1,
    cooldownMs: 1200,
    throwSpeed: 16,
    gravity: 18,
    maxFlightMs: 5000,         // a bit longer so bouncing has time to settle
    // Bounce physics — smoke acts like a flashbang canister, bouncing off
    // floors/walls/cover before going off.
    bounce: {
      maxBounces:    3,
      restitution:   0.5,      // y-velocity factor preserved on bounce
      wallRestitution: 0.55,   // similar for arena walls + cover faces
      friction:      0.7,      // x/z velocity factor on each ground hit
      settleSpeed:   1.5,      // speed² below this → settle + detonate
    },
    area: {
      radius: 4.5,
      durationMs: 9000,
      fadeInMs: 500,
      fadeOutMs: 1000,
      // Smoke is visual-only: no damage tick. Optionally hides nametags
      // when LOS crosses smoke (handled client-side via raycast).
    },
  },
};
const THROWABLE_TYPES = Object.keys(THROWABLE_CONFIG);
// Max angle (radians) between the player's known facing and a throw
// direction. Same threshold as shot-direction; throws are an aim action.
const MAX_THROW_DIRECTION_DEVIATION = 0.5;
function resolveRounds(votes) {
  const v = Object.values(votes || {}).filter(x => ROUND_OPTIONS.includes(x));
  if (v.length === 0)              return 5;
  if (v.every(x => x === v[0]))    return v[0];
  return v[Math.floor(Math.random() * v.length)];
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

// ── Team match lifecycle (2v2 / 3v3 / 5v5) ────────────────────────────────
// Team matches skip shooter_sessions (whose schema is 2-player) and instead
// log via game_sessions + the wallet ledger. The returned `matchId` IS the
// game_sessions row id so finishTeamShooterMatch can be idempotent.
async function startTeamShooterMatch(teamA, teamB, bet) {
  // teamA / teamB: arrays of userId strings.
  return withTx(async (client) => {
    const totalPot = (teamA.length + teamB.length) * bet;
    const { rows: gs } = await client.query(
      `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
       VALUES ('shooter','active',$1,$2)
       RETURNING id`,
      [bet, totalPot]
    );
    const sessionId = gs[0].id;
    // Deduct bet from every team member. Unique refIds so retries collide.
    let i = 0;
    for (const uid of teamA) {
      await adjustBalance(uid, -bet, 'bet', {
        refType: 'shooter', refId: `${sessionId}:a${i}`, client,
      });
      i++;
    }
    i = 0;
    for (const uid of teamB) {
      await adjustBalance(uid, -bet, 'bet', {
        refType: 'shooter', refId: `${sessionId}:b${i}`, client,
      });
      i++;
    }
    return { matchId: sessionId, sessionId };
  });
}

async function finishTeamShooterMatch(sessionId, winnerUserIds, loserUserIds, bet, reason = 'kills') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM game_sessions WHERE id = $1 FOR UPDATE`, [sessionId]
    );
    if (!rows.length) throw new Error('team_match_not_found');
    if (rows[0].status !== 'active') return { alreadyFinished: true };

    const totalPlayers = (winnerUserIds?.length || 0) + (loserUserIds?.length || 0);
    const pot = totalPlayers * bet;
    const fee = Math.floor(pot * (HOUSE_FEE_PERCENT / 100));
    const netPot = pot - fee;

    if (winnerUserIds?.length) {
      // Equal split among winners (integer cents — last winner picks up rounding).
      const share = Math.floor(netPot / winnerUserIds.length);
      const remainder = netPot - share * winnerUserIds.length;
      let idx = 0;
      for (const uid of winnerUserIds) {
        const payout = share + (idx === winnerUserIds.length - 1 ? remainder : 0);
        try {
          await adjustBalance(uid, payout, 'win', {
            refType: 'shooter', refId: `${sessionId}:wp${idx}`, client,
            metadata: { reason, fee, pot, teamMatch: true },
          });
        } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
        idx++;
      }
    } else {
      // No winner — refund every player.
      let idx = 0;
      for (const uid of [...(winnerUserIds || []), ...(loserUserIds || [])]) {
        try {
          await adjustBalance(uid, bet, 'refund', {
            refType: 'shooter', refId: `${sessionId}:r${idx}`, client, metadata: { reason },
          });
        } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
        idx++;
      }
    }

    await client.query(
      `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
      [sessionId]
    );
    return { payout: netPot, fee };
  });
}

async function cancelTeamShooterMatch(sessionId, members, bet, reason = 'cancelled') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM game_sessions WHERE id = $1 FOR UPDATE`, [sessionId]
    );
    if (!rows.length) return;
    if (rows[0].status !== 'active') return;
    let idx = 0;
    for (const uid of members) {
      try {
        await adjustBalance(uid, bet, 'refund', {
          refType: 'shooter', refId: `${sessionId}:c${idx}`, client, metadata: { reason },
        });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
      idx++;
    }
    await client.query(
      `UPDATE game_sessions SET status='cancelled', finished_at=NOW() WHERE id=$1`,
      [sessionId]
    );
  });
}

module.exports = {
  // Constants / configs
  LOBBY_DEFS, MAX_HEALTH, KILLS_TO_WIN, MATCH_DURATION_MS, RESPAWN_DELAY_MS,
  LAG_COMP_BUFFER_MS, PLAYER_HW, PLAYER_HEIGHT, MAX_MOVE_DELTA, WEAPONS, DEFAULT_WEAPON,
  // Server-authoritative tuneables
  MAX_MOVE_SPEED_UPS, MAX_ACCEL_UPS2, MAX_LAG_COMP_MS, MAX_CLIENT_TIME_DRIFT_MS,
  WEAPON_SWITCH_COOLDOWN_MS, SHOT_AFTER_SWITCH_MS, POSITION_HISTORY_MS,
  MOVEMENT_SNAPSHOT_INTERVAL_MS, MAX_SUSPICIOUS_SCORE, MAX_SHOT_DIRECTION_DEVIATION,
  // Live state (used by shooterSocket.js)
  lobbies, matches, players,
  // Helpers
  rayHitDistance, playerBox, headBox, coverAabb, positionAtTime,
  COVER_PENETRABLE_MIN, COVER_PENETRATION_DAMAGE_MULT,
  symmetricalMap, randomMap, csDepotMap, buildMapByType,
  MAP_TYPES, resolveMapType, lobbySnapshot,
  WEAPON_MODES, ROUND_OPTIONS, resolveWeaponMode, resolveRounds,
  TEAM_SIZES, privateLobbies, privateLobbiesByCode,
  THROWABLE_CONFIG, THROWABLE_TYPES, MAX_THROW_DIRECTION_DEVIATION,
  // Wallet-aware lifecycle
  startShooterMatch, finishShooterMatch, cancelShooterMatch, refundShooterMatch,
  startTeamShooterMatch, finishTeamShooterMatch, cancelTeamShooterMatch,
};
