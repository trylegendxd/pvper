// server/sockets/shooterSocket.js
// ============================================================================
//  All Socket.IO event handling for the Shooter Arena.
//  Migrated from the ORIGINAL server.js — only changes are:
//    * Auth comes from express-session (req.session.userId on socket.request).
//    * Bets go through the persistent wallet (games/shooter.js).
//    * Match results write to shooter_sessions.
//  The live-tick gameplay (hit detection, lag comp, weapon state) is unchanged.
// ============================================================================
const { pool } = require('../db');
const { getBalance } = require('../wallet');
const S = require('../games/shooter');
const Replay  = require('../games/shooterReplay');
const Ranking = require('../games/shooterRanking');

const {
  LOBBY_DEFS, MAX_HEALTH, KILLS_TO_WIN, MATCH_DURATION_MS, RESPAWN_DELAY_MS,
  PLAYER_HW, MAX_MOVE_DELTA, WEAPONS, DEFAULT_WEAPON,
  MAX_MOVE_SPEED_UPS, MAX_ACCEL_UPS2, MAX_CLIENT_TIME_DRIFT_MS,
  WEAPON_SWITCH_COOLDOWN_MS, SHOT_AFTER_SWITCH_MS,
  POSITION_HISTORY_MS, MOVEMENT_SNAPSHOT_INTERVAL_MS,
  MAX_SHOT_DIRECTION_DEVIATION,
  WEAPON_MODES, ROUND_OPTIONS, resolveWeaponMode, resolveRounds,
  TEAM_SIZES, privateLobbies,
  lobbies, matches, players,
  rayHitDistance, playerBox, headBox, coverAabb, positionAtTime,
  symmetricalMap, randomMap, resolveMapType, lobbySnapshot,
  startShooterMatch, finishShooterMatch, cancelShooterMatch,
  startTeamShooterMatch, finishTeamShooterMatch, cancelTeamShooterMatch,
} = S;

// Lightweight helper — logs a rejected action to the replay buffer AND bumps
// the per-player suspicious counter. Does not auto-ban or disconnect anyone.
function noteSuspicious(match, socketId, reason, extra = {}) {
  if (!match) return;
  const st = match.gameState?.[socketId];
  if (st) st.suspiciousScore = (st.suspiciousScore || 0) + 1;
  Replay.log(match.id, 'suspicious_action_rejected', { s: socketId, reason, ...extra });
}

function broadcastLobbies(io) {
  io.of('/shooter').emit('lobby_update', lobbySnapshot());
}

function buildWaitingUpdate(lobby) {
  return {
    players: lobby.players.map(id => {
      const p = players.get(id);
      return {
        id, username: p?.username ?? '?',
        mapVote:    lobby.mapVotes[id]    ?? null,
        modeVote:   lobby.modeVotes[id]   ?? null,
        roundsVote: lobby.roundsVotes[id] ?? null,
      };
    }),
  };
}

function endMatch(io, matchId, winnerArg, reason) {
  const match = matches.get(matchId);
  if (!match) return;
  if (match.ended) return;
  match.ended = true;
  if (match.timeoutTimer) { clearTimeout(match.timeoutTimer); match.timeoutTimer = null; }

  // ── Team match branch — wholly separate flow ─────────────────────
  if (match.isTeamMatch) {
    return endTeamMatch(io, match, winnerArg, reason);
  }

  // ── 1v1 branch (original logic) ──────────────────────────────────
  const winnerSocketId = winnerArg;
  const winnerPlayer = winnerSocketId ? players.get(winnerSocketId) : null;
  const aSock = match.playerIds[0];
  const bSock = match.playerIds[1];
  const aState = match.gameState[aSock] || { kills:0, deaths:0, shotsFired:0, shotsHit:0 };
  const bState = match.gameState[bSock] || { kills:0, deaths:0, shotsFired:0, shotsHit:0 };

  // Resolve user-ids for DB closure
  const aUser = players.get(aSock)?.userId;
  const bUser = players.get(bSock)?.userId;
  const winnerUserId = winnerPlayer?.userId ?? null;
  const isDraw = !winnerUserId;

  Replay.log(matchId, 'match_end', {
    reason,
    winnerSocket: winnerSocketId || null,
    aKills: aState.kills, bKills: bState.kills,
    aDeaths: aState.deaths, bDeaths: bState.deaths,
    aSusp: aState.suspiciousScore || 0,
    bSusp: bState.suspiciousScore || 0,
  });

  finishShooterMatch(match.dbMatchId, winnerUserId, reason, {
    aKills: aState.kills, bKills: bState.kills,
  }).then(async () => {
    // Persist replay events (one INSERT) — never block result delivery on this.
    Replay.flush(matchId, match.dbMatchId, {
      finalScore: { a: aState.kills, b: bState.kills },
      reason,
    }).catch(err => console.error('[shooter] replay flush failed', err));

    // Apply ranking — winner/loser stats, MMR, XP, level.
    let ranking = null;
    try {
      if (isDraw) {
        // Both players get base XP only; no MMR shift, no win/loss.
        if (aUser) await Ranking.applyMatchResult({
          winnerUserId: aUser, loserUserId: null, draw: true,
          winnerKills: aState.kills, winnerHeadshots: aState.headshots || 0,
          winnerShotsFired: aState.shotsFired, winnerShotsHit: aState.shotsHit,
        });
        if (bUser) await Ranking.applyMatchResult({
          winnerUserId: bUser, loserUserId: null, draw: true,
          winnerKills: bState.kills, winnerHeadshots: bState.headshots || 0,
          winnerShotsFired: bState.shotsFired, winnerShotsHit: bState.shotsHit,
        });
      } else {
        const winnerSt = winnerSocketId === aSock ? aState : bState;
        const loserSt  = winnerSocketId === aSock ? bState : aState;
        const loserUserId = winnerSocketId === aSock ? bUser : aUser;
        ranking = await Ranking.applyMatchResult({
          winnerUserId, loserUserId,
          winnerKills: winnerSt.kills, winnerHeadshots: winnerSt.headshots || 0,
          winnerShotsFired: winnerSt.shotsFired, winnerShotsHit: winnerSt.shotsHit,
          loserKills:  loserSt.kills,  loserHeadshots:  loserSt.headshots || 0,
          loserShotsFired:  loserSt.shotsFired,  loserShotsHit:  loserSt.shotsHit,
        });
      }
    } catch (e) {
      console.error('[shooter] ranking apply failed', e);
    }

    // Tell each player the result + new balance + progression
    for (const sockId of match.playerIds) {
      const sock = io.of('/shooter').sockets.get(sockId);
      const p = players.get(sockId);
      if (!p) continue;
      const newBalance = await getBalance(p.userId).catch(() => 0);
      const myState = match.gameState[sockId] || {};
      const won = winnerSocketId === sockId;
      const accuracy = myState.shotsFired > 0
        ? Math.round((myState.shotsHit / myState.shotsFired) * 100) : 0;
      const baseBet = match.betAmount;
      const creditChange = won ? +(baseBet) : -(baseBet);

      // Pull this player's ranking delta out of the result.
      let progress = null;
      if (ranking) {
        if (ranking.winner?.userId === p.userId) progress = ranking.winner;
        else if (ranking.loser?.userId === p.userId) progress = ranking.loser;
      }
      // Always echo the player's latest public stats so the UI can refresh.
      const liveStats = await Ranking.publicStatsFor(p.userId).catch(() => null);

      sock?.emit('match_end', {
        won, creditChange, newBalance, reason,
        stats: {
          kills: myState.kills || 0,
          deaths: myState.deaths || 0,
          headshots: myState.headshots || 0,
          shotsFired: myState.shotsFired || 0,
          shotsHit: myState.shotsHit || 0,
          accuracy,
        },
        ranking: progress,         // { xpGained, mmrChange, newMmr, newLevel, leveledUp, ... }
        liveStats,                 // current public profile snapshot
        replaySaved: true,         // killcam placeholder hook for the frontend
      });
    }
  }).catch(err => console.error('[shooter] finishMatch failed', err));

  // Clear per-player match references (lobby was already cleared when match started)
  for (const sockId of match.playerIds) {
    const p = players.get(sockId);
    if (p) { p.currentMatch = null; p.currentLobby = null; }
  }

  matches.delete(matchId);
  broadcastLobbies(io);
}

// ── Team-match end ──────────────────────────────────────────────────────
function endTeamMatch(io, match, winnerArg, reason) {
  const ns = io.of('/shooter');
  const winnerTeam = (winnerArg === 'a' || winnerArg === 'b') ? winnerArg : null;
  const winners = match.playerIds
    .map(id => ({ sock: id, state: match.gameState[id], userId: players.get(id)?.userId }))
    .filter(x => x.state && (winnerTeam ? x.state.team === winnerTeam : false));
  const losers = match.playerIds
    .map(id => ({ sock: id, state: match.gameState[id], userId: players.get(id)?.userId }))
    .filter(x => x.state && (winnerTeam ? x.state.team !== winnerTeam : true));

  Replay.log(match.id, 'match_end', {
    reason, teamMatch: true, winnerTeam,
    teamScores: match.teamScores,
  });

  const winUserIds = winners.map(w => w.userId).filter(Boolean);
  const losUserIds = losers .map(l => l.userId).filter(Boolean);

  finishTeamShooterMatch(match.sessionId, winUserIds, losUserIds, match.betAmount, reason)
    .then(async () => {
      Replay.flush(match.id, null, {
        teamMatch: true, finalScores: match.teamScores, reason,
      }).catch(err => console.error('[shooter] team replay flush failed', err));

      // Apply Elo per pair (winner vs each loser) so MMR still works.
      // Simple approach: each winner gains/loses MMR against the average
      // of the opposing team.
      try {
        if (winUserIds.length && losUserIds.length) {
          for (const w of winners) {
            for (const l of losers) {
              const wSt = match.gameState[w.sock] || {};
              const lSt = match.gameState[l.sock] || {};
              await Ranking.applyMatchResult({
                winnerUserId: w.userId, loserUserId: l.userId,
                winnerKills: Math.floor((wSt.kills || 0) / Math.max(1, losers.length)),
                winnerHeadshots: Math.floor((wSt.headshots || 0) / Math.max(1, losers.length)),
                winnerShotsFired: Math.floor((wSt.shotsFired || 0) / Math.max(1, losers.length)),
                winnerShotsHit:  Math.floor((wSt.shotsHit || 0) / Math.max(1, losers.length)),
                loserKills: Math.floor((lSt.kills || 0) / Math.max(1, winners.length)),
                loserHeadshots: Math.floor((lSt.headshots || 0) / Math.max(1, winners.length)),
                loserShotsFired: Math.floor((lSt.shotsFired || 0) / Math.max(1, winners.length)),
                loserShotsHit:  Math.floor((lSt.shotsHit || 0) / Math.max(1, winners.length)),
              }).catch(() => {});
            }
          }
        }
      } catch (e) { console.error('[shooter] team ranking failed', e); }

      // Tell every player.
      for (const id of match.playerIds) {
        const sock = ns.sockets.get(id);
        const p = players.get(id);
        if (!p) continue;
        const newBalance = await getBalance(p.userId).catch(() => 0);
        const me = match.gameState[id] || {};
        const isWinner = winnerTeam && me.team === winnerTeam;
        const baseBet = match.betAmount;
        const teamSize = match.teamSize;
        // Net change for the player: win → +bet share of the pot; lose → -bet
        const creditChange = isWinner ? +baseBet : -baseBet;
        const liveStats = await Ranking.publicStatsFor(p.userId).catch(() => null);
        sock?.emit('match_end', {
          won: !!isWinner,
          creditChange,
          newBalance,
          reason,
          isTeamMatch: true,
          teamScores: match.teamScores,
          yourTeam: me.team,
          stats: {
            kills: me.kills || 0,
            deaths: me.deaths || 0,
            headshots: me.headshots || 0,
            shotsFired: me.shotsFired || 0,
            shotsHit: me.shotsHit || 0,
            accuracy: me.shotsFired ? Math.round(((me.shotsHit || 0) / me.shotsFired) * 100) : 0,
          },
          liveStats,
          replaySaved: true,
        });
      }
    })
    .catch(err => console.error('[shooter] finishTeamMatch failed', err));

  for (const id of match.playerIds) {
    const p = players.get(id);
    if (p) { p.currentMatch = null; }
  }
  matches.delete(match.id);
}

// ── Private lobby helpers ───────────────────────────────────────────────
function snapshotPrivate(lobby) {
  return {
    id: lobby.id,
    hostUserId: lobby.hostUserId,
    teamSize: lobby.teamSize,
    bet: lobby.bet,
    weaponMode: lobby.weaponMode,
    killsToWin: lobby.killsToWin,
    status: lobby.status,
    members: lobby.members.map(m => ({
      userId: m.userId, username: m.username, team: m.team,
    })),
  };
}

function broadcastPrivateLobbyUpdate(io, lobby) {
  io.of('/shooter').to('priv:' + lobby.id).emit('private_lobby_update', snapshotPrivate(lobby));
}

function handleLeavePrivate(socket) {
  const me = players.get(socket.id);
  if (!me?.privateLobby) return;
  const lobby = privateLobbies.get(me.privateLobby);
  me.privateLobby = null;
  socket.leave('priv:' + (lobby?.id || ''));
  if (!lobby) return;
  // If a player leaves while the lobby is waiting, just drop them.
  if (lobby.status === 'waiting') {
    lobby.members = lobby.members.filter(m => m.socketId !== socket.id);
    if (!lobby.members.length || lobby.hostUserId === me.userId) {
      // Host left OR lobby empty — disband.
      privateLobbies.delete(lobby.id);
      socket.server.of('/shooter').to('priv:' + lobby.id).emit('private_lobby_disbanded', { reason: 'host_left' });
    } else {
      broadcastPrivateLobbyUpdate(socket.server.of('/shooter').server, lobby);
    }
  }
  // If the match was already in progress, the match-end forfeit path
  // will handle the rest via handleLeave.
}

// startPrivateMatch — boots a team-aware match from a filled private lobby.
async function startPrivateMatch(io, lobby) {
  // Mark lobby as in-progress immediately so a double-click can't fire twice.
  lobby.status = 'in_progress';
  broadcastPrivateLobbyUpdate(io, lobby);

  const ns = io.of('/shooter');
  const teamA = lobby.members.filter(m => m.team === 'a');
  const teamB = lobby.members.filter(m => m.team === 'b');
  const allMembers = [...teamA, ...teamB];

  // Wallet escrow for every player.
  let dbResult;
  try {
    dbResult = await startTeamShooterMatch(
      teamA.map(m => m.userId),
      teamB.map(m => m.userId),
      lobby.bet,
    );
  } catch (e) {
    console.error('[shooter] private match escrow failed', e);
    for (const m of allMembers) ns.to(m.socketId).emit('match_error', { error: e.message });
    privateLobbies.delete(lobby.id);
    return;
  }

  // Build spawn points: pair them across the map, alternating sides.
  const mapType = 'symmetrical';
  const coverBoxes = symmetricalMap();
  // Two rows of spawns — z= +17 for team A, z= -17 for team B.
  // x is staggered so team-mates don't overlap.
  const spawnFor = (team, idx) => {
    const xs = [-4, 0, 4, -8, 8];
    return { x: xs[idx % xs.length], y: 0, z: team === 'a' ? 17 : -17 };
  };

  const now = Date.now();
  const mkState = (team, spawnIdx) => ({
    position: { ...spawnFor(team, spawnIdx) }, rotation: { x:0, y: team === 'a' ? Math.PI : 0 },
    health: MAX_HEALTH, kills: 0, deaths: 0, headshots: 0,
    shotsFired: 0, shotsHit: 0,
    weapon: (lobby.weaponMode === 'all') ? DEFAULT_WEAPON : lobby.weaponMode,
    weapons: Object.fromEntries(
      Object.keys(WEAPONS).map(k => [k, { ammo: WEAPONS[k].mag, reloading: false, reloadStartedAt: 0 }])
    ),
    lastShot: 0, positionHistory: [], respawning: false,
    lastPosition: { ...spawnFor(team, spawnIdx) },
    lastMoveAt: now, lastWeaponSwitchAt: 0, suspiciousScore: 0,
    team,  // 'a' | 'b'
  });

  const gameState = {};
  const playerIds = [];
  teamA.forEach((m, i) => { gameState[m.socketId] = mkState('a', i); playerIds.push(m.socketId); });
  teamB.forEach((m, i) => { gameState[m.socketId] = mkState('b', i); playerIds.push(m.socketId); });

  const match = {
    id: dbResult.sessionId,
    dbMatchId: null,         // team matches don't use shooter_sessions
    sessionId: dbResult.sessionId,
    privateLobbyId: lobby.id,
    isTeamMatch: true,
    teamSize: lobby.teamSize,
    teamScores: { a: 0, b: 0 },
    playerIds,
    teamsByUserId: Object.fromEntries(allMembers.map(m => [m.userId, m.team])),
    mapType, coverBoxes,
    spawnPoints: playerIds.map((sid, i) => ({ ...gameState[sid].position })),
    startTime: now, endTime: now + MATCH_DURATION_MS,
    status: 'active',
    gameState,
    betAmount: lobby.bet,
    ended: false,
    coverAabbs: coverBoxes.map(coverAabb),
    weaponMode: lobby.weaponMode,
    killsToWin: lobby.killsToWin,
    memberUserIds: allMembers.map(m => m.userId),
  };
  matches.set(match.id, match);

  // Mark every player as being in this match and clear any other state.
  for (const m of allMembers) {
    const p = players.get(m.socketId);
    if (p) { p.currentMatch = match.id; p.currentLobby = null; p.privateLobby = null; }
  }
  // Start replay recorder.
  Replay.start(match.id, dbResult.sessionId, {
    privateLobbyId: lobby.id, bet: lobby.bet, mapType,
    teamMatch: true, teamSize: lobby.teamSize,
    players: Object.fromEntries(allMembers.map(m => [m.socketId, {
      userId: m.userId, username: m.username, team: m.team,
    }])),
  });

  // Tell every player the match started.
  const basePayload = {
    matchId: match.id, mapType, coverBoxes,
    spawnPoints: match.spawnPoints,
    endTime: match.endTime,
    weaponMode: lobby.weaponMode,
    killsToWin: lobby.killsToWin,
    isTeamMatch: true,
    teamSize: lobby.teamSize,
    players: Object.fromEntries(allMembers.map((m, i) => [m.socketId, {
      username: m.username, team: m.team, spawnIndex: i,
    }])),
  };
  for (const m of allMembers) {
    ns.to(m.socketId).emit('match_start', { ...basePayload, yourId: m.socketId, yourTeam: m.team });
  }
  // Match timer
  match.timeoutTimer = setTimeout(() => {
    if (matches.has(match.id) && !match.ended) endMatch(io, match.id, null, 'timeout');
  }, MATCH_DURATION_MS);

  privateLobbies.delete(lobby.id);
}

async function startMatch(io, lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.players.length !== 2) return;

  const [p1Id, p2Id] = lobby.players;
  const p1 = players.get(p1Id);
  const p2 = players.get(p2Id);
  if (!p1 || !p2) return;

  const mapType = resolveMapType(lobby.mapVotes);
  const coverBoxes = mapType === 'symmetrical' ? symmetricalMap() : randomMap();
  const spawnPoints = [{ x:0, y:0, z:17 }, { x:0, y:0, z:-17 }];
  // Per-match settings voted on in the waiting room.
  const weaponMode = resolveWeaponMode(lobby.modeVotes);
  const killsToWin = resolveRounds(lobby.roundsVotes);
  // Default loadout obeys the weapon-mode restriction.
  const defaultWeapon = (weaponMode === 'all') ? DEFAULT_WEAPON : weaponMode;

  // Wallet escrow
  let dbResult;
  try {
    dbResult = await startShooterMatch(p1.userId, p2.userId, lobbyId, lobby.bet);
  } catch (e) {
    console.error('[shooter] startMatch wallet failed', e);
    // Kick both back to lobby browser
    io.of('/shooter').to(p1Id).emit('match_error', { error: e.message });
    io.of('/shooter').to(p2Id).emit('match_error', { error: e.message });
    lobby.players = []; lobby.mapVotes = {}; lobby.modeVotes = {}; lobby.roundsVotes = {};
    lobby.status = 'waiting';
    broadcastLobbies(io);
    return;
  }

  const now = Date.now();
  const mkState = (spawnIdx) => ({
    position: { ...spawnPoints[spawnIdx] }, rotation: { x:0, y:0 },
    health: MAX_HEALTH, kills: 0, deaths: 0, headshots: 0,
    shotsFired: 0, shotsHit: 0,
    weapon: defaultWeapon,
    // One slot per weapon in WEAPONS — must include every key or the
    // respawn loop will throw when it tries to access an undefined slot.
    weapons: Object.fromEntries(
      Object.keys(WEAPONS).map(k => [k,
        { ammo: WEAPONS[k].mag, reloading: false, reloadStartedAt: 0 }
      ])
    ),
    lastShot: 0, positionHistory: [], respawning: false,
    lastPosition: { ...spawnPoints[spawnIdx] },
    // Server-authoritative tracking
    lastMoveAt: now,
    lastWeaponSwitchAt: 0,
    suspiciousScore: 0,
  });

  const match = {
    id: dbResult.matchId,
    dbMatchId: dbResult.matchId,
    sessionId: dbResult.sessionId,
    lobbyId,
    playerIds: [p1Id, p2Id],
    mapType, coverBoxes, spawnPoints,
    startTime: now, endTime: now + MATCH_DURATION_MS,
    status: 'active',
    gameState: { [p1Id]: mkState(0), [p2Id]: mkState(1) },
    betAmount: lobby.bet,
    ended: false,
    coverAabbs: coverBoxes.map(coverAabb),
    weaponMode,
    killsToWin,
  };
  matches.set(match.id, match);
  p1.currentMatch = match.id;
  p2.currentMatch = match.id;

  // Begin in-memory replay recording. One INSERT happens at match end.
  Replay.start(match.id, dbResult.sessionId, {
    lobbyId, bet: lobby.bet, mapType,
    players: {
      [p1Id]: { userId: p1.userId, username: p1.username, spawnIndex: 0 },
      [p2Id]: { userId: p2.userId, username: p2.username, spawnIndex: 1 },
    },
  });
  Replay.log(match.id, 'player_spawn', { s: p1Id, p: spawnPoints[0] });
  Replay.log(match.id, 'player_spawn', { s: p2Id, p: spawnPoints[1] });

  // Clear lobby immediately so new players can queue while this match runs
  lobby.players = [];
  lobby.mapVotes = {};
  lobby.modeVotes = {};
  lobby.roundsVotes = {};
  lobby.status = 'waiting';
  p1.currentLobby = null;
  p2.currentLobby = null;
  const ns = io.of('/shooter');
  ns.sockets.get(p1Id)?.leave(lobbyId);
  ns.sockets.get(p2Id)?.leave(lobbyId);
  broadcastLobbies(io);

  const basePayload = {
    matchId: match.id, mapType, coverBoxes, spawnPoints,
    endTime: match.endTime,
    weaponMode, killsToWin,
    players: {
      [p1Id]: { username: p1.username, spawnIndex: 0 },
      [p2Id]: { username: p2.username, spawnIndex: 1 },
    },
  };
  io.of('/shooter').to(p1Id).emit('match_start', { ...basePayload, yourId: p1Id });
  io.of('/shooter').to(p2Id).emit('match_start', { ...basePayload, yourId: p2Id });

  // Match timer — draw if no winner by deadline
  match.timeoutTimer = setTimeout(() => {
    if (matches.has(match.id) && !match.ended) endMatch(io, match.id, null, 'timeout');
  }, MATCH_DURATION_MS);
}

function attach(io) {
  const ns = io.of('/shooter');
  ns.use((socket, next) => {
    const req = socket.request;
    const userId = req?.session?.userId;
    if (!userId) return next(new Error('not_authenticated'));
    socket.data.userId = userId;
    next();
  });

  ns.on('connection', socket => {
    const userId = socket.data.userId;

    // Look up username + initial ranking for nice display
    Promise.all([
      pool.query('SELECT username FROM users WHERE id = $1', [userId]),
      Ranking.publicStatsFor(userId),
    ]).then(([{ rows }, liveStats]) => {
      const username = rows[0]?.username || 'player';
      players.set(socket.id, {
        id: socket.id, userId, username,
        currentLobby: null, currentMatch: null,
      });
      socket.emit('shooter_ready', {
        lobbies: lobbySnapshot(),
        ranking: liveStats,
        requirements: Ranking.LOBBY_REQUIREMENTS,
      });
    }).catch(err => {
      console.error('[shooter] connection setup failed', err);
      socket.emit('shooter_ready', { lobbies: lobbySnapshot() });
    });

    // Allow the client to ask for a fresh stats snapshot (e.g. after match)
    socket.on('get_stats', async (_, cb) => {
      try {
        const stats = await Ranking.publicStatsFor(userId);
        cb?.({ ok: true, ranking: stats, requirements: Ranking.LOBBY_REQUIREMENTS });
      } catch (e) {
        cb?.({ error: e.message });
      }
    });

    // ── join_lobby ─────────────────────────────────────────────────────
    socket.on('join_lobby', async ({ lobbyId } = {}, cb) => {
      const p = players.get(socket.id);
      const lobby = lobbies.get(lobbyId);
      if (!p) return cb?.({ error: 'not_ready' });
      if (!lobby) return cb?.({ error: 'no_lobby' });
      if (lobby.status === 'in_progress') return cb?.({ error: 'in_progress' });
      if (lobby.players.length >= 2) return cb?.({ error: 'full' });
      if (p.currentLobby) return cb?.({ error: 'already_in_lobby' });
      if (p.currentMatch) return cb?.({ error: 'already_in_match' });

      const balance = await getBalance(p.userId);
      if (balance < lobby.bet) return cb?.({ error: 'insufficient_balance' });

      // Tier gate — Bronze is open to all, higher tiers need level/matches/MMR.
      try {
        const stats = await Ranking.getOrCreateStats(p.userId);
        if (!Ranking.meetsRequirementsFor(lobbyId, stats)) {
          const req = Ranking.requirementsFor(lobbyId);
          return cb?.({ error: 'tier_locked', requirement: req });
        }
      } catch (e) {
        // If the ranking table is somehow unavailable, allow bronze only.
        if (lobbyId !== 'bronze') return cb?.({ error: 'ranking_unavailable' });
      }

      socket.join(lobbyId);
      lobby.players.push(socket.id);
      p.currentLobby = lobbyId;
      cb?.({ ok: true, lobby: { id: lobby.id, name: lobby.name, bet: lobby.bet } });

      ns.to(lobbyId).emit('waiting_room_update', buildWaitingUpdate(lobby));
      broadcastLobbies(io);

      if (lobby.players.length === 2) {
        // Give both players a 10-second window to vote on the map before
        // the match starts. Broadcast a countdown so the lobby UI can
        // show how long is left.
        const COUNTDOWN_MS = 10000;
        const startsAt = Date.now() + COUNTDOWN_MS;
        lobby.startsAt = startsAt;
        ns.to(lobbyId).emit('match_countdown', { startsAt, ms: COUNTDOWN_MS });
        clearTimeout(lobby._startTimer);
        lobby._startTimer = setTimeout(() => {
          lobby.startsAt = null;
          lobby._startTimer = null;
          startMatch(io, lobbyId);
        }, COUNTDOWN_MS);
      }
    });

    socket.on('vote_map', ({ mapType } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentLobby) return;
      if (!['symmetrical','random'].includes(mapType)) return;
      const lobby = lobbies.get(p.currentLobby);
      if (!lobby || lobby.status === 'in_progress') return;
      lobby.mapVotes[socket.id] = mapType;
      ns.to(p.currentLobby).emit('waiting_room_update', buildWaitingUpdate(lobby));
    });

    socket.on('vote_mode', ({ mode } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentLobby) return;
      if (!WEAPON_MODES.includes(mode)) return;
      const lobby = lobbies.get(p.currentLobby);
      if (!lobby || lobby.status === 'in_progress') return;
      lobby.modeVotes[socket.id] = mode;
      ns.to(p.currentLobby).emit('waiting_room_update', buildWaitingUpdate(lobby));
    });

    socket.on('vote_rounds', ({ rounds } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentLobby) return;
      const n = Number(rounds);
      if (!ROUND_OPTIONS.includes(n)) return;
      const lobby = lobbies.get(p.currentLobby);
      if (!lobby || lobby.status === 'in_progress') return;
      lobby.roundsVotes[socket.id] = n;
      ns.to(p.currentLobby).emit('waiting_room_update', buildWaitingUpdate(lobby));
    });

    // ── Private lobbies (host-created, invite-only) ──────────────────
    socket.on('create_private_lobby', async ({ teamSize, bet, weaponMode, killsToWin } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me) return cb?.({ error: 'not_ready' });
        if (me.privateLobby) return cb?.({ error: 'already_in_lobby' });
        const ts = Number(teamSize);
        if (!TEAM_SIZES.includes(ts)) return cb?.({ error: 'bad_team_size' });
        const b  = Math.max(1, Math.floor(Number(bet) || 50));
        const wm = WEAPON_MODES.includes(weaponMode) ? weaponMode : 'all';
        const kw = ROUND_OPTIONS.includes(Number(killsToWin)) ? Number(killsToWin) : 5;
        // Sanity: host must have the bet on hand to escrow later.
        const bal = await getBalance(me.userId);
        if (bal < b) return cb?.({ error: 'insufficient_balance' });

        const lobbyId = 'p-' + Math.random().toString(36).slice(2, 10);
        const lobby = {
          id: lobbyId,
          hostUserId: me.userId,
          hostSocketId: socket.id,
          teamSize: ts,
          bet: b,
          weaponMode: wm,
          killsToWin: kw,
          members: [{ socketId: socket.id, userId: me.userId, username: me.username, team: 'a' }],
          status: 'waiting',
          createdAt: Date.now(),
        };
        privateLobbies.set(lobbyId, lobby);
        me.privateLobby = lobbyId;
        socket.join('priv:' + lobbyId);
        cb?.({ ok: true, lobby: snapshotPrivate(lobby) });
        broadcastPrivateLobbyUpdate(io, lobby);
      } catch (e) {
        cb?.({ error: e.message || 'create_failed' });
      }
    });

    // Sends an invite to a friend via the /chat namespace.
    socket.on('invite_to_lobby', async ({ friendUserId } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
        const lobby = privateLobbies.get(me.privateLobby);
        if (!lobby || lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
        if (lobby.status !== 'waiting') return cb?.({ error: 'already_started' });
        if (lobby.members.length >= lobby.teamSize * 2) return cb?.({ error: 'lobby_full' });

        // Verify friendship.
        const [a, b] = me.userId < friendUserId ? [me.userId, friendUserId] : [friendUserId, me.userId];
        const { rows } = await pool.query(
          `SELECT 1 FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'`,
          [a, b]
        );
        if (!rows.length) return cb?.({ error: 'not_friends' });

        // Send via the /chat namespace's per-user room (u:<userId>).
        io.of('/chat').to(`u:${friendUserId}`).emit('lobby_invite', {
          lobbyId: lobby.id,
          fromUserId: me.userId,
          fromUsername: me.username,
          teamSize: lobby.teamSize,
          bet: lobby.bet,
          weaponMode: lobby.weaponMode,
          killsToWin: lobby.killsToWin,
        });
        cb?.({ ok: true });
      } catch (e) { cb?.({ error: e.message || 'invite_failed' }); }
    });

    socket.on('accept_invite', async ({ lobbyId } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me) return cb?.({ error: 'not_ready' });
        if (me.privateLobby) return cb?.({ error: 'already_in_lobby' });
        if (me.currentLobby || me.currentMatch) return cb?.({ error: 'busy' });
        const lobby = privateLobbies.get(lobbyId);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.status !== 'waiting') return cb?.({ error: 'already_started' });
        if (lobby.members.length >= lobby.teamSize * 2) return cb?.({ error: 'lobby_full' });

        const bal = await getBalance(me.userId);
        if (bal < lobby.bet) return cb?.({ error: 'insufficient_balance' });

        // Auto-team: first half of joiners on team A, rest on team B.
        const teamA = lobby.members.filter(m => m.team === 'a').length;
        const teamB = lobby.members.filter(m => m.team === 'b').length;
        const team = teamA <= teamB ? 'a' : 'b';
        lobby.members.push({ socketId: socket.id, userId: me.userId, username: me.username, team });
        me.privateLobby = lobby.id;
        socket.join('priv:' + lobby.id);
        cb?.({ ok: true, lobby: snapshotPrivate(lobby) });
        broadcastPrivateLobbyUpdate(io, lobby);
      } catch (e) { cb?.({ error: e.message || 'join_failed' }); }
    });

    socket.on('leave_private_lobby', (_, cb) => {
      handleLeavePrivate(socket);
      cb?.({ ok: true });
    });

    socket.on('start_private_match', async (_, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
        const lobby = privateLobbies.get(me.privateLobby);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
        if (lobby.status !== 'waiting') return cb?.({ error: 'already_started' });
        const need = lobby.teamSize * 2;
        if (lobby.members.length !== need) return cb?.({ error: 'lobby_not_full', need });
        cb?.({ ok: true });
        startPrivateMatch(io, lobby);
      } catch (e) { cb?.({ error: e.message || 'start_failed' }); }
    });

    socket.on('leave_lobby', (_, cb) => {
      handleLeave(socket);
      cb?.({ ok: true });
    });

    // ── player_move ───────────────────────────────────────────────────
    socket.on('player_move', ({ position, rotation, timestamp, yOffset, crouching } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.status !== 'active') return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;

      // Basic schema check.
      if (!position || typeof position.x !== 'number' || typeof position.z !== 'number') {
        return noteSuspicious(match, socket.id, 'invalid_position');
      }
      // Reject NaN / Infinity / out-of-arena positions.
      if (!Number.isFinite(position.x) || !Number.isFinite(position.z) ||
          Math.abs(position.x) > 50 || Math.abs(position.z) > 50) {
        socket.emit('position_correction', { position: state.lastPosition });
        return noteSuspicious(match, socket.id, 'out_of_bounds');
      }
      // Reject client timestamps too far out of sync.
      const serverNow = Date.now();
      const ts = Number(timestamp) || serverNow;
      if (Math.abs(ts - serverNow) > MAX_CLIENT_TIME_DRIFT_MS) {
        noteSuspicious(match, socket.id, 'time_drift', { drift: ts - serverNow });
      }

      const lastP = state.lastPosition;
      const dx = position.x - lastP.x, dz = position.z - lastP.z;
      const flatDist = Math.hypot(dx, dz);

      // Per-tick distance cap (original behaviour preserved).
      if (flatDist > MAX_MOVE_DELTA) {
        socket.emit('position_correction', { position: lastP });
        return noteSuspicious(match, socket.id, 'teleport', { dist: flatDist });
      }
      // Speed cap (units/sec). dtSec is bounded so a long-paused client
      // returning suddenly cannot pretend they moved freely the whole time.
      const dtMs = Math.max(1, Math.min(500, serverNow - state.lastMoveAt));
      const dtSec = dtMs / 1000;
      const speed = flatDist / dtSec;
      if (speed > MAX_MOVE_SPEED_UPS) {
        socket.emit('position_correction', { position: lastP });
        return noteSuspicious(match, socket.id, 'max_speed', { speed: +speed.toFixed(2) });
      }
      // Acceleration cap — sudden velocity spikes.
      const prevSpeed = state.lastSpeed || 0;
      const accel = Math.abs(speed - prevSpeed) / dtSec;
      if (accel > MAX_ACCEL_UPS2) {
        // Soft reject — don't snap the player back, just flag.
        noteSuspicious(match, socket.id, 'accel_spike', { accel: +accel.toFixed(1) });
      }

      state.position = { x: position.x, y: 0, z: position.z };
      state.rotation = rotation;
      state.lastPosition = { ...state.position };
      state.lastMoveAt = serverNow;
      state.lastSpeed = speed;

      state.positionHistory.push({ position: { ...state.position }, timestamp: ts });
      // Prune to POSITION_HISTORY_MS window (was a hardcoded 1000ms).
      const cutoff = serverNow - POSITION_HISTORY_MS;
      while (state.positionHistory.length && state.positionHistory[0].timestamp < cutoff) {
        state.positionHistory.shift();
      }

      // Capture jump/crouch state on the in-memory player record so the
      // replay layer can include them in movement snapshots. Gameplay
      // still uses y=0 for hit detection (these fields are visual only).
      state.yOffset   = Number(yOffset) || 0;
      state.crouching = !!crouching;

      // Throttled replay snapshot (every MOVEMENT_SNAPSHOT_INTERVAL_MS).
      // Rotation, jump height and crouch state ride along so the killcam
      // can replay the killer's POV faithfully.
      Replay.maybeMoveSnapshot(match.id, socket.id, state.position,
        MOVEMENT_SNAPSHOT_INTERVAL_MS, state.rotation,
        { yOffset: state.yOffset, crouching: state.crouching });

      // For team matches the move is broadcast to every other player; for
      // 1v1 it goes to the single opponent. Either way we include the
      // sender's socket id and team so multi-player clients can route the
      // update to the right model.
      const movePayload = {
        position: state.position, rotation: state.rotation, timestamp: ts,
        yOffset: state.yOffset || 0, crouching: !!state.crouching,
        senderSockId: socket.id,
        senderTeam: state.team || null,
      };
      if (match.isTeamMatch) {
        for (const id of match.playerIds) {
          if (id !== socket.id) ns.to(id).emit('opponent_move', movePayload);
        }
      } else {
        const oppSock = match.playerIds.find(id => id !== socket.id);
        if (oppSock) ns.to(oppSock).emit('opponent_move', movePayload);
      }
    });

    socket.on('switch_weapon', ({ weapon } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || !WEAPONS[weapon]) return;
      // Honour the lobby weapon-mode vote.
      if (match.weaponMode && match.weaponMode !== 'all' && weapon !== match.weaponMode) {
        return noteSuspicious(match, socket.id, 'weapon_disallowed', { mode: match.weaponMode, attempted: weapon });
      }
      const state = match.gameState[socket.id];
      if (!state) return;

      const now = Date.now();
      if (now - (state.lastWeaponSwitchAt || 0) < WEAPON_SWITCH_COOLDOWN_MS) {
        return noteSuspicious(match, socket.id, 'switch_cooldown');
      }
      if (weapon === state.weapon) return;

      state.weapon = weapon;
      state.lastWeaponSwitchAt = now;
      Replay.log(match.id, 'weapon_switch', { s: socket.id, w: weapon });
    });

    // ── shoot ─────────────────────────────────────────────────────────
    socket.on('shoot', ({ origin, direction, timestamp, directions } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.status !== 'active') return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;

      const wKey = state.weapon || DEFAULT_WEAPON;
      const W = WEAPONS[wKey];
      const wState = state.weapons[wKey];
      if (!W || !wState) return;
      // Honour the lobby weapon-mode vote.
      if (match.weaponMode && match.weaponMode !== 'all' && wKey !== match.weaponMode) {
        return noteSuspicious(match, socket.id, 'weapon_disallowed', { mode: match.weaponMode, attempted: wKey });
      }
      if (wState.reloading) return noteSuspicious(match, socket.id, 'shot_while_reloading');

      const now = Date.now();
      const ts  = Number(timestamp) || now;
      if (Math.abs(ts - now) > MAX_CLIENT_TIME_DRIFT_MS) {
        noteSuspicious(match, socket.id, 'shot_time_drift', { drift: ts - now });
      }
      if (now - state.lastShot < W.fireMs) {
        return noteSuspicious(match, socket.id, 'fire_rate', { delta: now - state.lastShot });
      }
      if (now - (state.lastWeaponSwitchAt || 0) < SHOT_AFTER_SWITCH_MS) {
        return noteSuspicious(match, socket.id, 'shot_after_switch');
      }
      if (wState.ammo <= 0) {
        return noteSuspicious(match, socket.id, 'empty_mag');
      }
      // Shot direction must point roughly where the player is looking.
      // rotation.y is the yaw (horizontal). Dot the look vector against the
      // submitted direction in the XZ plane; a wildly different direction is
      // an aimbot/spoof signal.
      if (direction && state.rotation && typeof state.rotation.y === 'number') {
        const yaw = state.rotation.y;
        const lookX = -Math.sin(yaw), lookZ = -Math.cos(yaw);
        const ml = Math.hypot(direction.x, direction.z) || 1;
        const dot = (direction.x / ml) * lookX + (direction.z / ml) * lookZ;
        if (dot < MAX_SHOT_DIRECTION_DEVIATION) {
          noteSuspicious(match, socket.id, 'shot_direction', { dot: +dot.toFixed(2) });
          // Don't reject — yaw on the server can lag behind the client's
          // micro-aim corrections. Logging is enough.
        }
      }

      state.lastShot = now;
      wState.ammo--;
      state.shotsFired++;
      Replay.log(match.id, 'shot_fired', {
        s: socket.id, w: wKey, ammo: wState.ammo,
        // Origin + direction let the killcam draw a tracer / muzzle flash
        // in the right place. Rounded so the event stays compact.
        o: origin ? [
          Math.round((origin.x ?? 0) * 100) / 100,
          Math.round((origin.y ?? 0) * 100) / 100,
          Math.round((origin.z ?? 0) * 100) / 100,
        ] : null,
        d: direction ? [
          Math.round((direction.x ?? 0) * 1000) / 1000,
          Math.round((direction.y ?? 0) * 1000) / 1000,
          Math.round((direction.z ?? 0) * 1000) / 1000,
        ] : null,
      });

      // Find every possible target: in team mode, only enemy team members;
      // in 1v1, the single other player. Respawning targets are skipped.
      const candidates = match.isTeamMatch
        ? match.playerIds.filter(id =>
            id !== socket.id &&
            match.gameState[id] &&
            !match.gameState[id].respawning &&
            match.gameState[id].team !== state.team)
        : (() => {
            const opp = match.playerIds.find(id => id !== socket.id);
            return (opp && match.gameState[opp] && !match.gameState[opp].respawning) ? [opp] : [];
          })();

      if (!candidates.length) {
        socket.emit('hit_result', { hit: false, ammo: wState.ammo, weapon: wKey });
        return;
      }

      const baseDirs = Array.isArray(directions) && directions.length ? directions : [direction];
      const rays = [];
      for (const bd of baseDirs) {
        const l = Math.hypot(bd.x, bd.y, bd.z);
        if (l < 1e-6) continue;
        const nx = bd.x / l, ny = bd.y / l, nz = bd.z / l;
        const pellets = (baseDirs.length === 1 && W.pellets > 1) ? W.pellets : 1;
        for (let i = 0; i < pellets; i++) {
          let dx = nx, dy = ny, dz = nz;
          if (pellets > 1) {
            dx += (Math.random() - 0.5) * W.spread;
            dy += (Math.random() - 0.5) * W.spread;
            dz += (Math.random() - 0.5) * W.spread;
            const m = Math.hypot(dx, dy, dz); dx /= m; dy /= m; dz /= m;
          }
          rays.push({ origin, direction: { x:dx, y:dy, z:dz } });
        }
      }

      const walls = [
        { min:{x:-20.25, y:0, z:-20.25}, max:{x: 20.25, y:3, z:-19.75} },
        { min:{x:-20.25, y:0, z: 19.75}, max:{x: 20.25, y:3, z: 20.25} },
        { min:{x:-20.25, y:0, z:-20.25}, max:{x:-19.75, y:3, z: 20.25} },
        { min:{x: 19.75, y:0, z:-20.25}, max:{x: 20.25, y:3, z: 20.25} },
      ];

      // For each candidate enemy, run all the rays and aggregate damage.
      // Pick the enemy with the closest hit (so a shot in a crowd hits
      // the one in front, not "every body it passes through").
      const rewindTs = timestamp ?? now;
      let bestTarget = null;
      let bestNearest = Infinity;
      let bestDmg = 0;
      let bestHead = false;

      for (const cSock of candidates) {
        const cState = match.gameState[cSock];
        const cPos = positionAtTime(cState.positionHistory, rewindTs) || cState.position;
        const bodyB = playerBox(cPos);
        const headB = headBox(cPos);

        let dmgHere = 0, hitHere = false, headHere = false, nearestHere = Infinity;
        for (const ray of rays) {
          let coverDist = Infinity;
          for (const c of match.coverAabbs) {
            const d = rayHitDistance(ray, c, 80); if (d < coverDist) coverDist = d;
          }
          for (const w of walls) {
            const d = rayHitDistance(ray, w, 80); if (d < coverDist) coverDist = d;
          }
          const headDist = rayHitDistance(ray, headB, 80);
          const bodyDist = rayHitDistance(ray, bodyB, 80);
          if (headDist < coverDist && headDist <= bodyDist) {
            dmgHere += W.headDmg; hitHere = true; headHere = true;
            if (headDist < nearestHere) nearestHere = headDist;
          } else if (bodyDist < coverDist && bodyDist !== Infinity) {
            dmgHere += W.dmg; hitHere = true;
            if (bodyDist < nearestHere) nearestHere = bodyDist;
          }
        }
        if (hitHere && nearestHere < bestNearest) {
          bestNearest = nearestHere;
          bestTarget  = cSock;
          bestDmg     = dmgHere;
          bestHead    = headHere;
        }
      }

      if (!bestTarget) {
        Replay.log(match.id, 'miss', { s: socket.id, w: wKey });
        socket.emit('hit_result', { hit: false, ammo: wState.ammo, weapon: wKey });
        return;
      }

      // Bind to the legacy variable names so the rest of the kill flow
      // (which uses oppSock / oppState / totalDmg / didHead / didHit)
      // keeps working unchanged.
      const oppSock  = bestTarget;
      const oppState = match.gameState[oppSock];
      const totalDmg = bestDmg;
      const didHead  = bestHead;
      const didHit   = true;

      state.shotsHit++;
      if (didHead) state.headshots = (state.headshots || 0) + 1;
      oppState.health = Math.max(0, oppState.health - totalDmg);

      // ── Death-time invulnerability ────────────────────────────────────
      // Flip `respawning` to true the instant health hits 0 so any other
      // shot landing in the same tick (different ray, queued packet) is
      // a no-op for damage. Was previously only set AFTER the kill emit,
      // leaving a tiny race window where a dead player could be re-killed.
      const fatal = oppState.health <= 0;
      if (fatal) oppState.respawning = true;

      Replay.log(match.id, didHead ? 'headshot' : 'bodyshot', {
        s: socket.id, target: oppSock, w: wKey, dmg: totalDmg, oppHp: oppState.health,
      });
      Replay.log(match.id, 'damage_dealt', {
        s: socket.id, target: oppSock, dmg: totalDmg,
      });
      socket.emit('hit_result', { hit: true, headshot: didHead, damage: totalDmg, ammo: wState.ammo, weapon: wKey });
      // Only inform the victim of damage if they were not already dead.
      // (If `fatal` then `you_hit` would arrive on the death screen.)
      if (!fatal) {
        ns.to(oppSock).emit('you_hit', { health: oppState.health, headshot: didHead });
      } else {
        ns.to(oppSock).emit('you_hit', { health: 0, headshot: didHead, fatal: true });
      }

      if (fatal) {
        state.kills++;
        oppState.deaths++;
        // Team mode: scoring is by team and the winner is whichever team
        // hits killsToWin first.
        let winnerSock = null;
        let teamWin = null;
        if (match.isTeamMatch) {
          match.teamScores[state.team]++;
          if (match.teamScores[state.team] >= (match.killsToWin || KILLS_TO_WIN)) {
            teamWin = state.team;
          }
          // Broadcast updated team scores so HUDs can update.
          for (const id of match.playerIds) {
            ns.to(id).emit('team_score_update', { scores: match.teamScores });
          }
        } else if (state.kills >= (match.killsToWin || KILLS_TO_WIN)) {
          winnerSock = socket.id;
        }

        const killPayload = {
          killerId: socket.id, killedId: oppSock,
          killerKills: state.kills, killedDeaths: oppState.deaths,
          killerName: players.get(socket.id)?.username || '?',
          killedName: players.get(oppSock)?.username || '?',
          headshot: didHead,
        };
        Replay.log(match.id, 'kill', {
          killer: socket.id, victim: oppSock, weapon: wKey, headshot: didHead,
          killerKills: state.kills, victimDeaths: oppState.deaths,
        });
        Replay.log(match.id, 'death', { s: oppSock, by: socket.id });

        // In team matches everyone needs the killfeed entry — broadcast
        // to all match members rather than just killer + victim.
        if (match.isTeamMatch) {
          for (const id of match.playerIds) ns.to(id).emit('kill_event', killPayload);
        } else {
          ns.to(socket.id).emit('kill_event', killPayload);
          ns.to(oppSock).emit('kill_event', killPayload);
        }

        // ── Killcam packet ─────────────────────────────────────────────
        // Send the victim the last 3 seconds of the killer's recorded
        // events so the client can play back the moment of death from
        // the killer's POV during the respawn countdown.
        try {
          const killcam = Replay.getRecentForKillcam(match.id, socket.id, 3000);
          if (killcam && killcam.length) {
            ns.to(oppSock).emit('killcam_data', {
              killerSocketId: socket.id,
              killerName: players.get(socket.id)?.username || '?',
              startedAtRel: killcam[0]?.t ?? 0,
              endsAtRel:    killcam[killcam.length - 1]?.t ?? 0,
              events: killcam,
              weapon: wKey,
              headshot: didHead,
            });
          }
        } catch (e) {
          console.error('[shooter] killcam build failed', e);
        }

        if (winnerSock || teamWin) {
          endMatch(io, match.id, winnerSock || teamWin, 'kills');
          return;
        }

        // Respawn opponent (already flagged respawning above). All work
        // wrapped in try/catch so an unexpected throw can't swallow the
        // respawn event — that bug previously left players stuck on the
        // death screen forever.
        const spawnIdx = match.playerIds.indexOf(oppSock);
        const spawn = { ...match.spawnPoints[spawnIdx] };
        setTimeout(() => {
          try {
            if (!matches.has(match.id) || matches.get(match.id).ended) return;
            oppState.health = MAX_HEALTH;
            for (const k of Object.keys(WEAPONS)) {
              // Lazily create any missing weapon slot.
              if (!oppState.weapons[k]) {
                oppState.weapons[k] = { ammo: WEAPONS[k].mag, reloading: false, reloadStartedAt: 0 };
              } else {
                oppState.weapons[k].ammo = WEAPONS[k].mag;
                oppState.weapons[k].reloading = false;
                oppState.weapons[k].reloadStartedAt = 0;
              }
            }
            oppState.position = spawn;
            oppState.lastPosition = { ...spawn };
            oppState.positionHistory = [];
            oppState.respawning = false;
            oppState.lastMoveAt = Date.now();
            oppState.lastSpeed  = 0;
            Replay.log(match.id, 'player_spawn', { s: oppSock, p: spawn });
            ns.to(oppSock).emit('respawn', { position: spawn, health: MAX_HEALTH });
            ns.to(socket.id).emit('opponent_respawn', { position: spawn });
          } catch (e) {
            console.error('[shooter] respawn failed, forcing fallback', e);
            // Still emit respawn so the player isn't stuck on the death
            // overlay forever, even if their state didn't update cleanly.
            try {
              oppState.respawning = false;
              ns.to(oppSock).emit('respawn', { position: spawn, health: MAX_HEALTH });
              ns.to(socket.id).emit('opponent_respawn', { position: spawn });
            } catch (_) {}
          }
        }, RESPAWN_DELAY_MS);
      }
    });

    socket.on('reload', () => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match) return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;

      const wKey = state.weapon || DEFAULT_WEAPON;
      const W = WEAPONS[wKey];
      const wState = state.weapons[wKey];
      if (!W || !wState) return;
      if (wState.reloading) return noteSuspicious(match, socket.id, 'reload_while_reloading');
      if (wState.ammo === W.mag) return; // nothing to do — silent, not suspicious

      wState.reloading = true;
      wState.reloadStartedAt = Date.now();
      Replay.log(match.id, 'reload_start', { s: socket.id, w: wKey });
      setTimeout(() => {
        if (!matches.has(match.id) || match.ended) return;
        wState.ammo = W.mag;
        wState.reloading = false;
        Replay.log(match.id, 'reload_complete', { s: socket.id, w: wKey, ammo: W.mag });
        socket.emit('reload_complete', { ammo: W.mag, weapon: wKey });
      }, W.reloadMs);
    });

    // ── In-game chat (between the two players in a live match) ──────
    socket.on('match_chat', ({ body } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.ended) return;
      const text = String(body || '').trim().slice(0, 200);
      if (!text) return;
      const oppSock = match.playerIds.find(id => id !== socket.id);
      if (!oppSock) return;
      // Only deliver to the opponent — sender echoes locally.
      ns.to(oppSock).emit('match_chat', {
        from: p.username || 'Opponent',
        body: text,
        isYou: false,
      });
    });

    socket.on('disconnect', () => {
      const p = players.get(socket.id);
      if (p?.currentMatch) Replay.log(p.currentMatch, 'disconnect', { s: socket.id });
      handleLeave(socket, true);
    });
  });

  function handleLeave(socket, fromDisconnect = false) {
    const p = players.get(socket.id);
    if (!p) return;

    // If in an active match, opponent wins by forfeit (1v1) — or the
    // other team wins only if THIS team is now empty (team mode).
    if (p.currentMatch) {
      const match = matches.get(p.currentMatch);
      if (match && !match.ended) {
        if (match.isTeamMatch) {
          // Remove the leaver from the playerIds list so move/shoot
          // broadcasts skip them, but keep the match going if their
          // team still has at least one player.
          const myTeam = match.gameState[socket.id]?.team;
          match.playerIds = match.playerIds.filter(id => id !== socket.id);
          if (match.gameState[socket.id]) {
            match.gameState[socket.id].respawning = true; // freeze them out
            delete match.gameState[socket.id];
          }
          // Did this team just empty out?
          const remaining = Object.values(match.gameState).filter(s => s.team === myTeam).length;
          if (remaining === 0 && myTeam) {
            const otherTeam = myTeam === 'a' ? 'b' : 'a';
            endMatch(io, match.id, otherTeam, fromDisconnect ? 'disconnect' : 'forfeit');
          }
        } else {
          const opp = match.playerIds.find(id => id !== socket.id);
          endMatch(io, match.id, opp, fromDisconnect ? 'disconnect' : 'forfeit');
        }
      }
    }
    // If they were in a private lobby (pre-match), clean that up too.
    if (p.privateLobby) {
      handleLeavePrivate(socket);
    }

    // Leave lobby and refund-not-needed (we hadn't escrowed yet — escrow happens in startMatch)
    if (p.currentLobby) {
      const lobby = lobbies.get(p.currentLobby);
      if (lobby) {
        lobby.players = lobby.players.filter(id => id !== socket.id);
        delete lobby.mapVotes[socket.id];
        delete lobby.modeVotes[socket.id];
        delete lobby.roundsVotes[socket.id];
        // Cancel any pending 10s countdown — both players need to be
        // present for the match to start.
        if (lobby._startTimer) {
          clearTimeout(lobby._startTimer);
          lobby._startTimer = null;
          lobby.startsAt = null;
          ns.to(p.currentLobby).emit('match_countdown_cancel');
        }
        ns.to(p.currentLobby).emit('waiting_room_update', buildWaitingUpdate(lobby));
      }
      socket.leave(p.currentLobby);
      p.currentLobby = null;
    }

    broadcastLobbies(io);
    players.delete(socket.id);
  }
}

module.exports = { attach };
