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

const {
  LOBBY_DEFS, MAX_HEALTH, KILLS_TO_WIN, MATCH_DURATION_MS, RESPAWN_DELAY_MS,
  PLAYER_HW, MAX_MOVE_DELTA, WEAPONS, DEFAULT_WEAPON,
  lobbies, matches, players,
  rayHitDistance, playerBox, headBox, coverAabb, positionAtTime,
  symmetricalMap, randomMap, resolveMapType, lobbySnapshot,
  startShooterMatch, finishShooterMatch, cancelShooterMatch,
} = S;

function broadcastLobbies(io) {
  io.of('/shooter').emit('lobby_update', lobbySnapshot());
}

function buildWaitingUpdate(lobby) {
  return {
    players: lobby.players.map(id => {
      const p = players.get(id);
      return {
        id, username: p?.username ?? '?',
        mapVote: lobby.mapVotes[id] ?? null,
      };
    }),
  };
}

function endMatch(io, matchId, winnerSocketId, reason) {
  const match = matches.get(matchId);
  if (!match) return;
  if (match.ended) return;
  match.ended = true;

  const winnerPlayer = winnerSocketId ? players.get(winnerSocketId) : null;
  const aSock = match.playerIds[0];
  const bSock = match.playerIds[1];
  const aState = match.gameState[aSock] || { kills:0, deaths:0, shotsFired:0, shotsHit:0 };
  const bState = match.gameState[bSock] || { kills:0, deaths:0, shotsFired:0, shotsHit:0 };

  // Resolve user-ids for DB closure
  const aUser = players.get(aSock)?.userId;
  const bUser = players.get(bSock)?.userId;
  const winnerUserId = winnerPlayer?.userId ?? null;

  finishShooterMatch(match.dbMatchId, winnerUserId, reason, {
    aKills: aState.kills, bKills: bState.kills,
  }).then(async () => {
    // Tell each player the result + new balance
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
      const creditChange = won ? +(baseBet) : -(baseBet);  // approx; precise change from wallet history if needed
      sock?.emit('match_end', {
        won, creditChange, newBalance, reason,
        stats: {
          kills: myState.kills || 0,
          deaths: myState.deaths || 0,
          shotsFired: myState.shotsFired || 0,
          shotsHit: myState.shotsHit || 0,
          accuracy,
        },
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

  // Wallet escrow
  let dbResult;
  try {
    dbResult = await startShooterMatch(p1.userId, p2.userId, lobbyId, lobby.bet);
  } catch (e) {
    console.error('[shooter] startMatch wallet failed', e);
    // Kick both back to lobby browser
    io.of('/shooter').to(p1Id).emit('match_error', { error: e.message });
    io.of('/shooter').to(p2Id).emit('match_error', { error: e.message });
    lobby.players = []; lobby.mapVotes = {}; lobby.status = 'waiting';
    broadcastLobbies(io);
    return;
  }

  const now = Date.now();
  const mkState = (spawnIdx) => ({
    position: { ...spawnPoints[spawnIdx] }, rotation: { x:0, y:0 },
    health: MAX_HEALTH, kills: 0, deaths: 0,
    shotsFired: 0, shotsHit: 0,
    weapon: DEFAULT_WEAPON,
    weapons: {
      rifle:   { ammo: WEAPONS.rifle.mag,   reloading: false },
      pistol:  { ammo: WEAPONS.pistol.mag,  reloading: false },
      shotgun: { ammo: WEAPONS.shotgun.mag, reloading: false },
    },
    lastShot: 0, positionHistory: [], respawning: false,
    lastPosition: { ...spawnPoints[spawnIdx] },
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
  };
  matches.set(match.id, match);
  p1.currentMatch = match.id;
  p2.currentMatch = match.id;

  // Clear lobby immediately so new players can queue while this match runs
  lobby.players = [];
  lobby.mapVotes = {};
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

    // Look up username for nice display
    pool.query('SELECT username FROM users WHERE id = $1', [userId])
      .then(({ rows }) => {
        const username = rows[0]?.username || 'player';
        players.set(socket.id, {
          id: socket.id, userId, username,
          currentLobby: null, currentMatch: null,
        });
        socket.emit('shooter_ready', { lobbies: lobbySnapshot() });
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

      socket.join(lobbyId);
      lobby.players.push(socket.id);
      p.currentLobby = lobbyId;
      cb?.({ ok: true, lobby: { id: lobby.id, name: lobby.name, bet: lobby.bet } });

      ns.to(lobbyId).emit('waiting_room_update', buildWaitingUpdate(lobby));
      broadcastLobbies(io);

      if (lobby.players.length === 2) {
        setTimeout(() => startMatch(io, lobbyId), 800);
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

    socket.on('leave_lobby', (_, cb) => {
      handleLeave(socket);
      cb?.({ ok: true });
    });

    // ── player_move ───────────────────────────────────────────────────
    socket.on('player_move', ({ position, rotation, timestamp } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.status !== 'active') return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;

      // Anti-cheat: reject teleports
      const lastP = state.lastPosition;
      const dx = position.x - lastP.x, dz = position.z - lastP.z;
      if (Math.hypot(dx, dz) > MAX_MOVE_DELTA) {
        socket.emit('position_correction', { position: lastP });
        return;
      }
      state.position = { x: position.x, y: 0, z: position.z };
      state.rotation = rotation;
      state.lastPosition = { ...state.position };

      state.positionHistory.push({ position: { ...state.position }, timestamp: timestamp ?? Date.now() });
      // Prune
      const cutoff = Date.now() - 1000;
      while (state.positionHistory.length && state.positionHistory[0].timestamp < cutoff) {
        state.positionHistory.shift();
      }

      const oppSock = match.playerIds.find(id => id !== socket.id);
      if (oppSock) ns.to(oppSock).emit('opponent_move', {
        position: state.position, rotation: state.rotation, timestamp: timestamp ?? Date.now(),
      });
    });

    socket.on('switch_weapon', ({ weapon } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || !WEAPONS[weapon]) return;
      const state = match.gameState[socket.id];
      if (!state) return;
      state.weapon = weapon;
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
      if (!W || !wState || wState.reloading) return;

      const now = Date.now();
      if (now - state.lastShot < W.fireMs) return;
      if (wState.ammo <= 0) return;
      state.lastShot = now;
      wState.ammo--;
      state.shotsFired++;

      const oppSock = match.playerIds.find(id => id !== socket.id);
      const oppState = match.gameState[oppSock];
      if (!oppState || oppState.respawning) {
        socket.emit('hit_result', { hit: false, ammo: wState.ammo, weapon: wKey });
        return;
      }

      const rewindTs  = timestamp ?? now;
      const rewindPos = positionAtTime(oppState.positionHistory, rewindTs) || oppState.position;
      const bodyB = playerBox(rewindPos);
      const headB = headBox(rewindPos);

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

      let totalDmg = 0, didHit = false, didHead = false;
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
          totalDmg += W.headDmg; didHit = true; didHead = true;
        } else if (bodyDist < coverDist && bodyDist !== Infinity) {
          totalDmg += W.dmg; didHit = true;
        }
      }

      if (!didHit) {
        socket.emit('hit_result', { hit: false, ammo: wState.ammo, weapon: wKey });
        return;
      }

      state.shotsHit++;
      oppState.health = Math.max(0, oppState.health - totalDmg);
      socket.emit('hit_result', { hit: true, headshot: didHead, damage: totalDmg, ammo: wState.ammo, weapon: wKey });
      ns.to(oppSock).emit('you_hit', { health: oppState.health, headshot: didHead });

      if (oppState.health <= 0) {
        state.kills++;
        oppState.deaths++;
        const winnerSock = state.kills >= KILLS_TO_WIN ? socket.id : null;

        const killPayload = {
          killerId: socket.id, killedId: oppSock,
          killerKills: state.kills, killedDeaths: oppState.deaths,
          killerName: players.get(socket.id)?.username || '?',
          killedName: players.get(oppSock)?.username || '?',
          headshot: didHead,
        };
        ns.to(socket.id).emit('kill_event', killPayload);
        ns.to(oppSock).emit('kill_event', killPayload);

        if (winnerSock) {
          endMatch(io, match.id, winnerSock, 'kills');
          return;
        }

        // Respawn opponent
        oppState.respawning = true;
        const spawnIdx = match.playerIds.indexOf(oppSock);
        const spawn = { ...match.spawnPoints[spawnIdx] };
        setTimeout(() => {
          if (!matches.has(match.id) || matches.get(match.id).ended) return;
          oppState.health = MAX_HEALTH;
          for (const k of Object.keys(WEAPONS)) {
            oppState.weapons[k].ammo = WEAPONS[k].mag;
            oppState.weapons[k].reloading = false;
          }
          oppState.position = spawn;
          oppState.lastPosition = { ...spawn };
          oppState.positionHistory = [];
          oppState.respawning = false;
          ns.to(oppSock).emit('respawn', { position: spawn, health: MAX_HEALTH });
          ns.to(socket.id).emit('opponent_respawn', { position: spawn });
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
      if (!W || !wState || wState.reloading || wState.ammo === W.mag) return;

      wState.reloading = true;
      setTimeout(() => {
        if (!matches.has(match.id) || match.ended) return;
        wState.ammo = W.mag;
        wState.reloading = false;
        socket.emit('reload_complete', { ammo: W.mag, weapon: wKey });
      }, W.reloadMs);
    });

    socket.on('disconnect', () => handleLeave(socket, true));
  });

  function handleLeave(socket, fromDisconnect = false) {
    const p = players.get(socket.id);
    if (!p) return;

    // If in an active match, opponent wins by forfeit
    if (p.currentMatch) {
      const match = matches.get(p.currentMatch);
      if (match && !match.ended) {
        const opp = match.playerIds.find(id => id !== socket.id);
        endMatch(io, match.id, opp, fromDisconnect ? 'disconnect' : 'forfeit');
      }
    }

    // Leave lobby and refund-not-needed (we hadn't escrowed yet — escrow happens in startMatch)
    if (p.currentLobby) {
      const lobby = lobbies.get(p.currentLobby);
      if (lobby) {
        lobby.players = lobby.players.filter(id => id !== socket.id);
        delete lobby.mapVotes[socket.id];
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
