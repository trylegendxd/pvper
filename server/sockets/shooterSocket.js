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
const Replay       = require('../games/shooterReplay');
const Ranking      = require('../games/shooterRanking');
const Achievements = require('../games/shooterAchievements');

// Spawn invulnerability — every fresh respawn gets this much grace
// before damage applies again, so a player can't be shot the instant
// the death overlay clears.
const SPAWN_INVULN_MS = 1000;

// ── CS:GO-style round economy ───────────────────────────────────────────────
// A purely IN-MATCH virtual currency — completely separate from the player's
// real credit balance / wallet. The real wager (bet → pot → winner) is
// untouched; this money only decides which gun you can spawn with each round.
//
// Mapping to this deathmatch: every life is a "round". You start a match with
// START_MONEY, buy a loadout during the buy window, and keep whatever gun you
// bought as long as you stay alive (survivors carry weapons across rounds, just
// like CS). When you die you respawn with the default pistol+knife, collect a
// loss bonus, and get a fresh buy window to re-arm. Killing earns money based
// on the weapon used. The economy is only enabled for "all weapons" matches —
// fixed weapon-mode lobbies keep their classic behaviour.
const ECON = {
  START_MONEY:     800,                         // CS pistol-round bank
  MAX_MONEY:       16000,
  BUY_TIME_MS:     11000,                       // buy window length after the freeze
  FREEZE_MS:       3500,                        // CS buy-freeze: can buy, can't move/shoot
  DEFAULT_LOADOUT: ['knife', 'pistol'],         // free starting kit
  // CS:GO weapon prices (pistol/knife are the free kit).
  PRICES:   { knife: 0, pistol: 0, deagle: 700, shotgun: 1100, smg: 1250, scout: 1700, rifle: 2700, m4: 3100, sniper: 4750 },
  // Kill rewards (kept modest): rifles/pistols $250, snipers less, SMG/shotgun
  // more (CS-style eco-weapon bonus), knife $600. In this fast deathmatch a
  // "round" is a single kill, so these are deliberately much smaller than
  // CS's per-round economy.
  KILL_REWARD: { knife: 600, pistol: 250, deagle: 250, smg: 500, shotgun: 400, rifle: 250, m4: 250, scout: 250, sniper: 150, molotov: 250, smoke: 250 },
  ROUND_WIN_BONUS: 250,                          // small win bonus on top of the kill reward
  // Escalating loss bonus by consecutive deaths (capped) so a losing player
  // can still slowly re-arm.
  LOSS_BONUS:      [900, 1200, 1500, 1800, 2100],
};
// What the client needs to render the buy menu + HUD. Sent inside match_start.
const ECON_PUBLIC = {
  startMoney:    ECON.START_MONEY,
  maxMoney:      ECON.MAX_MONEY,
  buyTimeMs:     ECON.BUY_TIME_MS,
  freezeMs:      ECON.FREEZE_MS,
  prices:        ECON.PRICES,
  defaultLoadout:ECON.DEFAULT_LOADOUT,
  roundWinBonus: ECON.ROUND_WIN_BONUS,
  lossBonus:     ECON.LOSS_BONUS,
};

function econActive(match) { return !!(match && match.economy); }
// True while a player is in their buy-freeze (can shop, can't move or shoot).
function econFrozen(state) { return !!(state && state.freezeUntil && Date.now() < state.freezeUntil); }

// Decide whether a freshly-built match runs the economy, and seed every
// player's money / loadout / opening freeze. Called right after matches.set().
function initMatchEconomy(match) {
  match.economy = (match.weaponMode === 'all');
  if (!match.economy) return;
  const t = Date.now();
  for (const sid of match.playerIds) {
    const st = match.gameState[sid];
    if (!st) continue;
    st.money      = ECON.START_MONEY;
    st.loadout    = new Set(ECON.DEFAULT_LOADOUT);
    st.lossStreak = 0;
    st.weapon     = 'pistol';                    // spawn with the free pistol
    // Opening buy freeze — everyone starts at spawn, frozen, shopping.
    st.freezeUntil = t + ECON.FREEZE_MS;
    st.buyUntil    = st.freezeUntil + ECON.BUY_TIME_MS;
    st.invulnUntil = Math.max(st.invulnUntil || 0, st.freezeUntil + 400);
  }
}

// Per-player economy snapshot for the match_start / resume payload.
function econPlayerSnapshot(st) {
  return {
    money:       st?.money ?? ECON.START_MONEY,
    loadout:     st?.loadout ? [...st.loadout] : [...ECON.DEFAULT_LOADOUT],
    buyUntil:    st?.buyUntil ?? (Date.now() + ECON.BUY_TIME_MS),
    freezeUntil: st?.freezeUntil ?? 0,
  };
}

// Killer won the round → kill reward + round-win bonus, loss streak reset.
function awardKillEconomy(io, match, killerSid, killerState, weaponKey) {
  if (!econActive(match) || !killerState) return;
  const reward = (ECON.KILL_REWARD[weaponKey] ?? 300) + ECON.ROUND_WIN_BONUS;
  killerState.lossStreak = 0;
  killerState.money = Math.min(ECON.MAX_MONEY, (killerState.money || 0) + reward);
  io.of('/shooter').to(killerSid).emit('economy_update', {
    money: killerState.money, delta: reward, reason: 'round_win',
  });
}

// Victim lost the round → escalating loss bonus, reset loadout, fresh buy
// freeze. Returns the freezeUntil so the respawn path can match invuln to it.
function respawnEconomy(io, match, sid, state) {
  if (!econActive(match) || !state) return 0;
  state.lossStreak = Math.min(ECON.LOSS_BONUS.length, (state.lossStreak || 0) + 1);
  const bonus = ECON.LOSS_BONUS[state.lossStreak - 1];
  state.money       = Math.min(ECON.MAX_MONEY, (state.money || 0) + bonus);
  state.loadout     = new Set(ECON.DEFAULT_LOADOUT);
  state.weapon      = 'pistol';
  state.freezeUntil = Date.now() + ECON.FREEZE_MS;
  state.buyUntil    = state.freezeUntil + ECON.BUY_TIME_MS;
  io.of('/shooter').to(sid).emit('buy_open', {
    money: state.money, loadout: [...state.loadout],
    buyUntil: state.buyUntil, freezeUntil: state.freezeUntil,
    delta: bonus, reason: 'round_loss',
  });
  return state.freezeUntil;
}

// Emit a one-shot invuln event to all players in a match so they can
// render an aura (or skip their own crosshair fire-confirm). Best-effort
// — if io isn't ready yet (called from a very early respawn path) the
// emit just no-ops.
function emitInvulnStart(io, match, socketId, until) {
  if (!io || !match) return;
  const ns = io.of('/shooter');
  const payload = { socketId, until };
  for (const sid of match.playerIds) ns.to(sid).emit('invuln_start', payload);
}

// Fire a single achievement grant to a single socket. Awaits the DB
// write, then emits if anything was actually new. Wrapped in try/catch
// so the kill flow is never delayed by an achievement bug.
function tryGrant(io, socketId, userId, key) {
  if (!userId || !key) return;
  Achievements.grantOne(userId, key).then(def => {
    if (def && _ioRef) {
      _ioRef.of('/shooter').to(socketId).emit('achievement_unlocked', def);
    }
  }).catch(() => {});
}

// Build the scoreboard snapshot for an active match. Used both at
// match_start (initial state) and after every kill so the in-match
// TAB scoreboard always reflects current K/D/HS.
function buildScoreboard(match) {
  return {
    isTeamMatch: !!match.isTeamMatch,
    teamScores: match.teamScores || null,
    killsToWin: match.killsToWin || null,
    players: match.playerIds.map((sid) => {
      const st = match.gameState[sid] || {};
      const p  = players.get(sid);
      return {
        socketId: sid,
        username: p?.username || '?',
        team: st.team || null,
        kills:     st.kills     || 0,
        deaths:    st.deaths    || 0,
        headshots: st.headshots || 0,
        connected: !st.disconnected,
        respawning: !!st.respawning,
      };
    }),
  };
}

function emitScoreboard(io, match) {
  if (!io || !match || match.ended) return;
  const ns = io.of('/shooter');
  const payload = buildScoreboard(match);
  for (const sid of match.playerIds) ns.to(sid).emit('scoreboard_update', payload);
}

const {
  LOBBY_DEFS, MAX_HEALTH, KILLS_TO_WIN, MATCH_DURATION_MS, RESPAWN_DELAY_MS,
  PLAYER_HW, MAX_MOVE_DELTA, WEAPONS, DEFAULT_WEAPON,
  MAX_MOVE_SPEED_UPS, MAX_ACCEL_UPS2, MAX_CLIENT_TIME_DRIFT_MS,
  WEAPON_SWITCH_COOLDOWN_MS, SHOT_AFTER_SWITCH_MS,
  POSITION_HISTORY_MS, MOVEMENT_SNAPSHOT_INTERVAL_MS,
  MAX_SHOT_DIRECTION_DEVIATION,
  WEAPON_MODES, ROUND_OPTIONS, resolveWeaponMode, resolveRounds,
  TEAM_SIZES, privateLobbies, privateLobbiesByCode,
  THROWABLE_CONFIG, THROWABLE_TYPES, MAX_THROW_DIRECTION_DEVIATION,
  lobbies, matches, players,
  rayHitDistance, playerBox, headBox, coverAabb, arenaWalls, positionAtTime,
  COVER_PENETRATION_DAMAGE_MULT, damageMultiplier,
  symmetricalMap, randomMap, csDepotMap, buildMapByType,
  MAP_TYPES, resolveMapType, lobbySnapshot,
  startShooterMatch, finishShooterMatch, cancelShooterMatch,
  startTeamShooterMatch, finishTeamShooterMatch, cancelTeamShooterMatch,
} = S;

// Module-level reference to the Socket.IO instance, populated by attach().
// noteSuspicious/kickForCheating need it to forfeit the match without
// having to thread io through every caller.
let _ioRef = null;

// Anti-cheat threshold. MAX_SUSPICIOUS_SCORE (50) is intentionally a high
// "soft cap" purely for logging; CHEAT_KICK_THRESHOLD is the actual
// auto-action point. Set lower so a sustained pattern of rejected actions
// (movement teleports, fire-rate violations, weapon-mode bypasses, shots
// after switching weapons, etc.) ends the match instead of just being
// logged for an admin to read.
const CHEAT_KICK_THRESHOLD = 30;

// Reasons that are BENIGN client/server desyncs (reload + fire timing, ammo
// races, the freeze/economy loadout races, weapon-switch cooldowns). These are
// still rejected so they can't be exploited, but they must NEVER count toward
// an auto-kick — they fire constantly for honest laggy players and were the
// cause of false "cheat" kicks after reloading. Only the genuinely
// cheat-shaped reasons (teleport, out-of-bounds, speed/accel) accumulate.
const BENIGN_SUSPICIOUS = new Set([
  'shot_while_reloading', 'reload_while_reloading', 'empty_mag',
  'shot_after_switch', 'fire_rate', 'shot_time_drift', 'shot_direction',
  'switch_cooldown', 'weapon_not_owned', 'switch_not_owned', 'time_drift',
]);

// Lightweight helper — logs a rejected action to the replay buffer, bumps
// the per-player suspicious counter (only for cheat-shaped reasons), and once
// the counter exceeds the kick threshold forfeits the match.
function noteSuspicious(match, socketId, reason, extra = {}) {
  if (!match) return;
  const st = match.gameState?.[socketId];
  if (!st) return;
  const weight = BENIGN_SUSPICIOUS.has(reason) ? 0 : 1;
  st.suspiciousScore = (st.suspiciousScore || 0) + weight;
  Replay.log(match.id, 'suspicious_action_rejected', {
    s: socketId, reason, score: st.suspiciousScore, benign: weight === 0, ...extra,
  });
  if (weight && st.suspiciousScore > CHEAT_KICK_THRESHOLD && !st.cheatKicked) {
    st.cheatKicked = true;
    kickForCheating(match, socketId, reason);
  }
}

// Auto-forfeit a player whose suspicious score has crossed the threshold.
// Logs an audit_logs row (best-effort), forfeits the match using the
// existing endMatch path, and disconnects the offending socket.
function kickForCheating(match, socketId, lastReason) {
  if (!_ioRef || !match || match.ended) return;
  const ns = _ioRef.of('/shooter');
  const p = players.get(socketId);
  Replay.log(match.id, 'cheat_kick', { s: socketId, lastReason });

  // Audit log — fire and forget; never block on it.
  pool.query(
    `INSERT INTO audit_logs (action, target_id, details)
     VALUES ('cheat_kick', $1, $2::jsonb)`,
    [p?.userId || null, JSON.stringify({
      matchId: match.id, socketId, lastReason,
      score: match.gameState?.[socketId]?.suspiciousScore,
      isTeamMatch: !!match.isTeamMatch,
      tier: match.lobbyId,
    })]
  ).catch(() => {});

  // Tell the offender + everyone else in the match so HUDs can show why
  // the match ended.
  ns.to(socketId).emit('match_error', { error: 'cheat_kick', reason: lastReason });
  for (const sid of match.playerIds) {
    if (sid !== socketId) ns.to(sid).emit('opponent_kicked', { socketId, reason: 'cheating' });
  }

  // Forfeit: opponent (1v1) or other team (team modes) wins via the
  // existing endMatch path. For team modes, only end the match if the
  // kicked player's team is now empty — otherwise just remove them.
  if (match.isTeamMatch) {
    const myTeam = match.gameState[socketId]?.team;
    match.playerIds = match.playerIds.filter(id => id !== socketId);
    delete match.gameState[socketId];
    const remaining = Object.values(match.gameState).filter(s => s.team === myTeam).length;
    if (remaining === 0 && myTeam) {
      endMatch(_ioRef, match.id, myTeam === 'a' ? 'b' : 'a', 'cheat_kick');
    }
  } else {
    const opp = match.playerIds.find(id => id !== socketId);
    endMatch(_ioRef, match.id, opp, 'cheat_kick');
  }

  // Drop the connection — they'll have to reconnect to play again.
  const sock = ns.sockets.get(socketId);
  if (sock) {
    setTimeout(() => { try { sock.disconnect(true); } catch (_) {} }, 100);
  }
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

      // Achievement scan — uses the per-player match stats + their
      // post-match public profile (level, streak, total matches) to
      // detect milestone unlocks. Each grant is checked vs an in-memory
      // owned-set so duplicates skip the DB write.
      const matchStatsForAch = {
        kills:    myState.kills || 0,
        deaths:   myState.deaths || 0,
        headshots: myState.headshots || 0,
      };
      const newAchievements = await Achievements.detectMatchEnd({
        userId: p.userId, isWinner: won,
        matchStats: matchStatsForAch, liveStats,
      }).catch(() => []);

      // Head-to-head: ship the OPPONENT's stats too so the post-match
      // screen can render a side-by-side comparison instead of just
      // listing what the player did in isolation.
      const oppState = (sockId === aSock ? bState : aState) || {};
      const oppPlayer = sockId === aSock ? players.get(bSock) : players.get(aSock);
      const oppShotsFired = oppState.shotsFired || 0;
      const oppAccuracy = oppShotsFired
        ? Math.round(((oppState.shotsHit || 0) / oppShotsFired) * 100)
        : 0;

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
        opponentStats: {
          username: oppPlayer?.username || '?',
          kills: oppState.kills || 0,
          deaths: oppState.deaths || 0,
          headshots: oppState.headshots || 0,
          shotsFired: oppShotsFired,
          shotsHit: oppState.shotsHit || 0,
          accuracy: oppAccuracy,
        },
        ranking: progress,         // { xpGained, mmrChange, newMmr, newLevel, leveledUp, ... }
        liveStats,                 // current public profile snapshot
        replaySaved: true,         // killcam placeholder hook for the frontend
        achievements: newAchievements, // newly-earned achievements for the toast
      });
    }
  }).catch(err => console.error('[shooter] finishMatch failed', err));

  // Clear per-player match references (lobby was already cleared when match started)
  for (const sockId of match.playerIds) {
    const p = players.get(sockId);
    if (p) { p.currentMatch = null; p.currentLobby = null; }
  }

  stopThrowableTick(match);
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
        const newAchievements = await Achievements.detectMatchEnd({
          userId: p.userId, isWinner: !!isWinner,
          matchStats: {
            kills: me.kills || 0, deaths: me.deaths || 0, headshots: me.headshots || 0,
          },
          liveStats,
        }).catch(() => []);
        // Aggregate the enemy team's combat stats so the post-match
        // screen can show "your team vs theirs" alongside the per-player
        // numbers.
        const enemyTeam = me.team === 'a' ? 'b' : 'a';
        const enemyStates = Object.values(match.gameState).filter(s => s.team === enemyTeam);
        const enemyAgg = enemyStates.reduce((acc, s) => ({
          kills:      acc.kills      + (s.kills || 0),
          deaths:     acc.deaths     + (s.deaths || 0),
          headshots:  acc.headshots  + (s.headshots || 0),
          shotsFired: acc.shotsFired + (s.shotsFired || 0),
          shotsHit:   acc.shotsHit   + (s.shotsHit || 0),
        }), { kills: 0, deaths: 0, headshots: 0, shotsFired: 0, shotsHit: 0 });
        const enemyAcc = enemyAgg.shotsFired
          ? Math.round((enemyAgg.shotsHit / enemyAgg.shotsFired) * 100) : 0;

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
          opponentStats: {
            username: `Team ${enemyTeam.toUpperCase()} (${enemyStates.length})`,
            ...enemyAgg,
            accuracy: enemyAcc,
          },
          liveStats,
          replaySaved: true,
          achievements: newAchievements,
        });
      }
    })
    .catch(err => console.error('[shooter] finishTeamMatch failed', err));

  for (const id of match.playerIds) {
    const p = players.get(id);
    if (p) { p.currentMatch = null; }
  }
  stopThrowableTick(match);
  matches.delete(match.id);
}

// ── Private lobby helpers ───────────────────────────────────────────────
// Short, readable invite codes — 6 chars from an unambiguous alphabet
// (no 0/O/1/I) so users can read & type them aloud.
function generateInviteCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += A[Math.floor(Math.random() * A.length)];
    if (!privateLobbiesByCode.has(code)) return code;
  }
  // Astronomically unlikely fallback.
  return 'P' + Date.now().toString(36).toUpperCase().slice(-5);
}

// Lobby is "ready" when every required slot is filled, teams are balanced,
// AND every non-host member has flipped ready=true. Host can still start
// without their own ready flag set (their click on START is the implicit ready).
function lobbyReadiness(lobby) {
  const need = lobby.teamSize * 2;
  const filled = lobby.members.length === need;
  const aCount = lobby.members.filter(m => m.team === 'a').length;
  const bCount = lobby.members.filter(m => m.team === 'b').length;
  const balanced = aCount === lobby.teamSize && bCount === lobby.teamSize;
  const others = lobby.members.filter(m => m.userId !== lobby.hostUserId);
  const allReady = others.length === 0 || others.every(m => m.ready);
  return { filled, balanced, allReady, allOk: filled && balanced && allReady };
}

function snapshotPrivate(lobby) {
  const { filled, balanced, allReady } = lobbyReadiness(lobby);
  return {
    id: lobby.id,
    code: lobby.inviteCode,
    hostUserId: lobby.hostUserId,
    teamSize: lobby.teamSize,
    maxPlayers: lobby.teamSize * 2,
    mode: lobby.mode,
    bet: lobby.bet,
    weaponMode: lobby.weaponMode,
    killsToWin: lobby.killsToWin,
    status: lobby.status,
    derived: { filled, balanced, allReady },
    members: lobby.members.map(m => ({
      userId: m.userId,
      username: m.username,
      team: m.team,
      ready: !!m.ready,
      isHost: m.userId === lobby.hostUserId,
      connected: !!(m.socketId && players.has(m.socketId)),
    })),
  };
}

// ── Throwables (Molotov + Smoke) ────────────────────────────────────────
function mkThrowables() {
  const out = {};
  for (const k of THROWABLE_TYPES) out[k] = { count: THROWABLE_CONFIG[k].count };
  return out;
}

function refillThrowables(state) {
  for (const k of THROWABLE_TYPES) {
    if (state.throwables[k]) state.throwables[k].count = THROWABLE_CONFIG[k].count;
    else                     state.throwables[k] = { count: THROWABLE_CONFIG[k].count };
  }
  state.lastThrowAt = 0;
}

// Start the per-match throwable tick. Idempotent — safe to call twice.
function ensureThrowableTick(io, match) {
  match._io = io;          // captured for stopThrowableTick's flush
  if (match.throwableTickTimer) return;
  match.projectiles = match.projectiles || new Map();
  match.areaEffects = match.areaEffects || new Map();
  const TICK_MS = 100;
  match.throwableTickTimer = setInterval(() => tickThrowables(io, match), TICK_MS);
}

function stopThrowableTick(match) {
  if (!match) return;
  if (match.throwableTickTimer) {
    clearInterval(match.throwableTickTimer);
    match.throwableTickTimer = null;
  }
  // Flush any in-flight projectiles + active area effects so clients
  // don't end up with leftover fire/smoke on the post-match screen.
  if (match.matchEndCleanupDone) return;
  match.matchEndCleanupDone = true;
  try {
    const io = match._io;
    if (!io) return;
    const ns = io.of('/shooter');
    if (match.projectiles) {
      for (const [pid, p] of match.projectiles) {
        ns.to(match.playerIds).emit('throwable_impact', {
          id: pid, type: p.type,
          position: { x: p.position.x, y: 0, z: p.position.z },
          ownerSocketId: p.ownerSocketId,
        });
      }
      match.projectiles.clear();
    }
    if (match.areaEffects) {
      for (const [aid] of match.areaEffects) {
        for (const sid of match.playerIds) ns.to(sid).emit('area_effect_end', { id: aid });
      }
      match.areaEffects.clear();
    }
  } catch (_) { /* swallow — cleanup must never throw */ }
}

// Reflect a projectile off the surface it just intersected, with
// restitution + friction so it loses energy like a real canister.
// Mutates p.position and p.velocity in place.
function bounceProjectile(p, kind, cover, px, py, pz, nx, ny, nz, bcfg, arenaSize = 40) {
  const R   = bcfg.restitution;
  const RW  = bcfg.wallRestitution;
  const FR  = bcfg.friction;

  if (kind === 'ground') {
    // Snap above floor, bounce y, friction x/z.
    p.position.x = nx;
    p.position.y = 0.05;
    p.position.z = nz;
    p.velocity.y = Math.abs(p.velocity.y) * R;
    p.velocity.x *= FR;
    p.velocity.z *= FR;
    return;
  }
  if (kind === 'wall') {
    // Arena edge — reflect whichever axis went out of bounds. Scaled to
    // the real arena size (was hard-coded to the 40-unit ±20.5 boundary,
    // which clamped Depot throwables to the middle of the map).
    const half = arenaSize / 2;
    const edge = half + 0.5;
    if (Math.abs(nx) > half + 1) {
      p.position.x = Math.sign(nx) * edge;
      p.position.y = ny;
      p.position.z = nz;
      p.velocity.x = -p.velocity.x * RW;
      p.velocity.y *= FR;
      p.velocity.z *= FR;
    } else {
      p.position.x = nx;
      p.position.y = ny;
      p.position.z = Math.sign(nz) * edge;
      p.velocity.z = -p.velocity.z * RW;
      p.velocity.x *= FR;
      p.velocity.y *= FR;
    }
    return;
  }
  // kind === 'cover' — figure out which face based on where we came from.
  // Whichever axis the previous position was OUTSIDE on is the entry face.
  if (cover) {
    if (py >= cover.max.y) {
      // Top — bounce up.
      p.position.x = nx;
      p.position.y = cover.max.y + 0.02;
      p.position.z = nz;
      p.velocity.y = Math.abs(p.velocity.y) * R;
      p.velocity.x *= FR;
      p.velocity.z *= FR;
    } else if (px <= cover.min.x) {
      p.position.x = cover.min.x - 0.02;
      p.position.y = ny;
      p.position.z = nz;
      p.velocity.x = -Math.abs(p.velocity.x) * RW;
      p.velocity.y *= FR;
      p.velocity.z *= FR;
    } else if (px >= cover.max.x) {
      p.position.x = cover.max.x + 0.02;
      p.position.y = ny;
      p.position.z = nz;
      p.velocity.x = Math.abs(p.velocity.x) * RW;
      p.velocity.y *= FR;
      p.velocity.z *= FR;
    } else if (pz <= cover.min.z) {
      p.position.x = nx;
      p.position.y = ny;
      p.position.z = cover.min.z - 0.02;
      p.velocity.z = -Math.abs(p.velocity.z) * RW;
      p.velocity.y *= FR;
      p.velocity.x *= FR;
    } else if (pz >= cover.max.z) {
      p.position.x = nx;
      p.position.y = ny;
      p.position.z = cover.max.z + 0.02;
      p.velocity.z = Math.abs(p.velocity.z) * RW;
      p.velocity.y *= FR;
      p.velocity.x *= FR;
    } else {
      // Started inside (shouldn't happen) — pop to the nearest face top.
      p.position.x = nx;
      p.position.y = cover.max.y + 0.02;
      p.position.z = nz;
      p.velocity.y = Math.abs(p.velocity.y) * R;
      p.velocity.x *= FR;
      p.velocity.z *= FR;
    }
  }
}

// Per-tick projectile + area-effect simulation.
function tickThrowables(io, match) {
  if (!match || match.ended) { stopThrowableTick(match); return; }
  const ns = io.of('/shooter');
  const now = Date.now();
  const dt  = 0.1; // 100 ms

  // ── Projectiles: arc physics with simple ground/cover collision ──────
  for (const [pid, p] of match.projectiles) {
    // Save previous position so collisions can pick the right reflect axis.
    const px = p.position.x, py = p.position.y, pz = p.position.z;

    const cfg = THROWABLE_CONFIG[p.type];
    p.velocity.y -= cfg.gravity * dt;
    const nx = p.position.x + p.velocity.x * dt;
    const ny = p.position.y + p.velocity.y * dt;
    const nz = p.position.z + p.velocity.z * dt;

    // Classify this tick's collision (if any).
    let hitKind = null;       // 'ground' | 'wall' | 'cover' | null
    let hitCover = null;
    if (ny <= 0) hitKind = 'ground';
    if (!hitKind) {
      for (const c of (match.coverAabbs || [])) {
        if (nx >= c.min.x && nx <= c.max.x &&
            ny >= c.min.y && ny <= c.max.y &&
            nz >= c.min.z && nz <= c.max.z) {
          hitKind = 'cover'; hitCover = c; break;
        }
      }
    }
    // Boundary check scaled to the real arena (was hard-coded ±21 for a
    // 40-unit map, which made throwables bounce off mid-air on Depot).
    const throwWall = (match.arenaSize || 40) / 2 + 1;
    if (!hitKind && (Math.abs(nx) > throwWall || Math.abs(nz) > throwWall)) hitKind = 'wall';

    // Expiration → fall-in-place impact (prevents stuck-in-air ghosts).
    const expired = now >= p.expiresAt;
    if (!hitKind && expired) hitKind = 'ground';

    if (!hitKind) {
      // No collision — advance and stream.
      p.position.x = nx; p.position.y = ny; p.position.z = nz;
      ns.to(match.playerIds).emit('throwable_projectile_update', {
        id: pid, position: p.position, velocity: p.velocity,
      });
      continue;
    }

    // SMOKE: bounce up to maxBounces times before detonating.
    const bcfg = THROWABLE_CONFIG.smoke?.bounce;
    if (p.type === 'smoke' && bcfg && !expired && (p.bounceCount || 0) < bcfg.maxBounces) {
      bounceProjectile(p, hitKind, hitCover, px, py, pz, nx, ny, nz, bcfg, match.arenaSize || 40);
      p.bounceCount = (p.bounceCount || 0) + 1;
      // If basically standstill after the bounce, settle and detonate.
      const v2 = p.velocity.x*p.velocity.x + p.velocity.y*p.velocity.y + p.velocity.z*p.velocity.z;
      if (v2 < bcfg.settleSpeed) {
        const impactPos = { x: p.position.x, y: 0, z: p.position.z };
        match.projectiles.delete(pid);
        ns.to(match.playerIds).emit('throwable_impact', {
          id: pid, type: p.type, position: impactPos, ownerSocketId: p.ownerSocketId,
        });
        spawnAreaEffect(io, match, p.type, impactPos, p.ownerSocketId, p.ownerUserId, p.ownerTeam);
        continue;
      }
      // Broadcast the bounce so clients can sync.
      ns.to(match.playerIds).emit('throwable_bounce', {
        id: pid, position: p.position, velocity: p.velocity,
        bounceCount: p.bounceCount, kind: hitKind,
      });
      continue;
    }

    // MOLOTOV (or smoke past max bounces / expired): detonate.
    const impactPos = { x: nx, y: 0, z: nz };
    match.projectiles.delete(pid);
    ns.to(match.playerIds).emit('throwable_impact', {
      id: pid, type: p.type, position: impactPos, ownerSocketId: p.ownerSocketId,
    });
    spawnAreaEffect(io, match, p.type, impactPos, p.ownerSocketId, p.ownerUserId, p.ownerTeam);
  }

  // ── Area effects: tick damage for fire, auto-expire all ──────────────
  for (const [aid, eff] of match.areaEffects) {
    if (now >= eff.endsAt) {
      match.areaEffects.delete(aid);
      for (const sid of match.playerIds) ns.to(sid).emit('area_effect_end', { id: aid });
      continue;
    }
    if (eff.type !== 'molotov') continue;
    const cfg = THROWABLE_CONFIG.molotov.area;
    if (now - (eff.lastTickAt || 0) < cfg.tickIntervalMs) continue;
    eff.lastTickAt = now;

    // Damage every player inside the radius (no friendly fire by default).
    for (const [sid, state] of Object.entries(match.gameState)) {
      if (!state || state.respawning) continue;
      if (!cfg.friendlyFire && eff.ownerTeam && state.team === eff.ownerTeam) continue;
      const dx = state.position.x - eff.position.x;
      const dz = state.position.z - eff.position.z;
      if (Math.hypot(dx, dz) > eff.radius) continue;

      // Apply damage.
      state.health = Math.max(0, state.health - cfg.tickDamage);
      const fatal = state.health <= 0;
      if (fatal) state.respawning = true;
      // Notify the victim.
      emitYouHit(ns, sid, eff.position, {
        health: state.health, headshot: false, fatal, source: 'molotov',
      });
      Replay.log(match.id, 'damage_dealt', {
        s: eff.ownerSocketId, target: sid, dmg: cfg.tickDamage, kind: 'fire',
      });

      if (fatal) {
        const killerState = match.gameState[eff.ownerSocketId];
        if (killerState) killerState.kills = (killerState.kills || 0) + 1;
        awardKillEconomy(io, match, eff.ownerSocketId, killerState, 'molotov');  // CS economy
        state.deaths = (state.deaths || 0) + 1;
        // Score team win / 1v1 win check.
        let teamWin = null, winnerSock = null;
        if (match.isTeamMatch && killerState) {
          match.teamScores[killerState.team] = (match.teamScores[killerState.team] || 0) + 1;
          for (const id of match.playerIds) ns.to(id).emit('team_score_update', { scores: match.teamScores });
          if (match.teamScores[killerState.team] >= (match.killsToWin || KILLS_TO_WIN)) {
            teamWin = killerState.team;
          }
        } else if (killerState && killerState.kills >= (match.killsToWin || KILLS_TO_WIN)) {
          winnerSock = eff.ownerSocketId;
        }
        const killPayload = {
          killerId: eff.ownerSocketId, killedId: sid,
          killerKills: killerState?.kills || 0, killedDeaths: state.deaths || 0,
          killerName: players.get(eff.ownerSocketId)?.username || 'Molotov',
          killedName: players.get(sid)?.username || '?',
          headshot: false, weapon: 'molotov',
        };
        Replay.log(match.id, 'kill', {
          killer: eff.ownerSocketId, victim: sid, weapon: 'molotov',
          killerKills: killerState?.kills || 0, victimDeaths: state.deaths || 0,
        });
        Replay.log(match.id, 'death', { s: sid, by: eff.ownerSocketId });
        if (match.isTeamMatch) {
          for (const id of match.playerIds) ns.to(id).emit('kill_event', killPayload);
        } else {
          ns.to(eff.ownerSocketId).emit('kill_event', killPayload);
          ns.to(sid).emit('kill_event', killPayload);
        }
        // Push a full scoreboard refresh so the TAB scoreboard stays in
        // sync without each client having to track every kill_event.
        emitScoreboard(io, match);
        if (winnerSock || teamWin) {
          endMatch(io, match.id, winnerSock || teamWin, 'kills');
          return;
        }
        // Respawn the victim after the normal delay.
        const spawnIdx = match.playerIds.indexOf(sid);
        const spawn = { ...match.spawnPoints[spawnIdx] };
        setTimeout(() => {
          try {
            if (!matches.has(match.id) || matches.get(match.id).ended) return;
            state.health = MAX_HEALTH;
            for (const k of Object.keys(WEAPONS)) {
              if (!state.weapons[k]) state.weapons[k] = { ammo: WEAPONS[k].mag, reloading: false, reloadStartedAt: 0 };
              else { state.weapons[k].ammo = WEAPONS[k].mag; state.weapons[k].reloading = false; }
            }
            refillThrowables(state);
            const freezeUntil = respawnEconomy(io, match, sid, state);   // CS economy: loss bonus + rebuy
            state.position = spawn;
            state.lastPosition = { ...spawn };
            state.positionHistory = [];
            state.respawning = false;
            state.lastMoveAt = Date.now();
            state.lastSpeed = 0;
            const invulnUntil = freezeUntil ? freezeUntil + 500 : Date.now() + SPAWN_INVULN_MS;
            state.invulnUntil = invulnUntil;
            state.streakKills = 0;
            ns.to(sid).emit('respawn', { position: spawn, health: MAX_HEALTH, invulnUntil, freezeUntil });
            const otherSock = match.playerIds.find(x => x !== sid);
            if (otherSock) ns.to(otherSock).emit('opponent_respawn', { position: spawn, invulnUntil });
            emitInvulnStart(io, match, sid, invulnUntil);
          } catch (e) { console.error('[shooter] fire respawn failed', e); }
        }, RESPAWN_DELAY_MS);
      }
    }
  }
}

function spawnAreaEffect(io, match, type, position, ownerSocketId, ownerUserId, ownerTeam) {
  const cfg = THROWABLE_CONFIG[type]?.area;
  if (!cfg) return;
  const id = 'a-' + Math.random().toString(36).slice(2, 10);
  const now = Date.now();
  const eff = {
    id, type,
    ownerSocketId, ownerUserId, ownerTeam,
    position: { x: position.x, y: 0, z: position.z },
    radius: cfg.radius,
    startedAt: now,
    endsAt: now + cfg.durationMs,
    lastTickAt: 0,
  };
  match.areaEffects.set(id, eff);
  for (const sid of match.playerIds) {
    io.of('/shooter').to(sid).emit('area_effect_start', {
      id, type, position: eff.position, radius: eff.radius,
      startedAt: eff.startedAt, endsAt: eff.endsAt,
      ownerSocketId, ownerTeam: ownerTeam || null,
    });
  }
  Replay.log(match.id, 'area_effect_start', { id, type, p: [position.x, 0, position.z] });
}

function broadcastPrivateLobbyUpdate(io, lobby) {
  const snap = snapshotPrivate(lobby);
  const ns = io.of('/shooter');
  // Primary path: emit to the room.
  ns.to('priv:' + lobby.id).emit('private_lobby_update', snap);
  // Belt-and-suspenders: ALSO emit directly to each member's socket.
  // Rescues the case where a transient disconnect/reconnect dropped a
  // member's room subscription, which is otherwise invisible until
  // they reload the page.
  for (const m of lobby.members) {
    if (!m.socketId) continue;
    const sock = ns.sockets.get(m.socketId);
    if (sock) sock.emit('private_lobby_update', snap);
  }
}

// Find an active private lobby for this user (used to rejoin them to the
// lobby room when they reconnect).
function findPrivateLobbyForUser(userId) {
  for (const lobby of privateLobbies.values()) {
    const m = lobby.members.find(x => x.userId === userId);
    if (m) return { lobby, member: m };
  }
  return null;
}

// Same lookup for public arena lobbies. lobby.players holds socket ids
// so we have to resolve to userId via the players map. Returns the
// slot index so callers can replace the stale socket id in place.
function findPublicLobbyForUser(userId) {
  for (const lobby of lobbies.values()) {
    for (let i = 0; i < lobby.players.length; i++) {
      const p = players.get(lobby.players[i]);
      if (p?.userId === userId) return { lobby, slot: i, oldSid: lobby.players[i] };
    }
  }
  return null;
}

// Shared reset for public arena lobbies. Used by every path that has
// to abort a half-formed match (escrow failed, start aborted, lobby
// empty, etc.).
function resetPublicLobby(lobby) {
  lobby.players = [];
  lobby.mapVotes = {};
  lobby.modeVotes = {};
  lobby.roundsVotes = {};
  lobby.status = 'waiting';
  if (lobby._startTimer) { clearTimeout(lobby._startTimer); lobby._startTimer = null; }
  lobby.startsAt = null;
}

// Single point of truth for `you_hit` emits. Centralises the
// attackerPos plumbing so adding another damage source (grenade etc.)
// doesn't re-duplicate the field shape.
function emitYouHit(ns, victimSid, attackerPos, payload) {
  ns.to(victimSid).emit('you_hit', {
    ...payload,
    attackerPos: attackerPos ? { x: attackerPos.x, z: attackerPos.z } : null,
  });
}

// ── Reconnect grace for private lobbies ─────────────────────────────────
// When a tab refreshes, the browser drops its socket; without a grace
// window the disconnect handler would immediately leave the lobby (or
// disband it if the host was the only one), so the moment the new
// socket connects there's nothing to come back to. We delay the leave
// by RECONNECT_GRACE_MS and cancel it on the next /shooter connection
// for the same user.
const RECONNECT_GRACE_MS = 15000;
const pendingDisconnects = new Map(); // userId → setTimeout handle

// Active-match grace window. A refresh during a real match used to be an
// instant forfeit; now the disconnected player has RECONNECT_MATCH_GRACE_MS
// to come back before endMatch fires. State stays alive in match.gameState
// (with respawning=true so they can't be shot at or moved), and the
// connection handler re-keys it to the new socket id on return.
const RECONNECT_MATCH_GRACE_MS = 10000;
const pendingMatchReconnects = new Map(); // userId → { matchId, oldSocketId, timer, deadlineAt }

function scheduleLeavePrivate(io, userId, socket) {
  // If the user already has a pending leave, reset the timer.
  if (pendingDisconnects.has(userId)) {
    clearTimeout(pendingDisconnects.get(userId));
  }
  const timer = setTimeout(() => {
    pendingDisconnects.delete(userId);
    // Only actually leave if the user hasn't reconnected — verify by
    // checking the member's current socketId against the connected
    // sockets. If the lobby is gone already, nothing to do.
    const existing = findPrivateLobbyForUser(userId);
    if (!existing) return;
    // If a live socket exists for this user, they came back — bail.
    const sock = io.of('/shooter').sockets.get(existing.member.socketId);
    if (sock) return;
    // Otherwise, perform the actual leave.
    const lobby = existing.lobby;
    lobby.members = lobby.members.filter(m => m.userId !== userId);
    if (!lobby.members.length) {
      disbandPrivateLobby(io, lobby, 'host_left');
      return;
    }
    if (lobby.hostUserId === userId) {
      const next = lobby.members.find(m => m.socketId && players.has(m.socketId)) || lobby.members[0];
      if (!next?.socketId || !players.has(next.socketId)) {
        disbandPrivateLobby(io, lobby, 'host_left');
        return;
      }
      lobby.hostUserId = next.userId;
      lobby.hostSocketId = next.socketId;
      unreadyNonHost(lobby);
      io.of('/shooter').to('priv:' + lobby.id).emit('host_transferred', {
        newHostUserId: next.userId, newHostUsername: next.username,
      });
    }
    if (lobby.status === 'ready') lobby.status = 'waiting';
    broadcastPrivateLobbyUpdate(io, lobby);
  }, RECONNECT_GRACE_MS);
  pendingDisconnects.set(userId, timer);
}

function cancelLeavePrivate(userId) {
  if (pendingDisconnects.has(userId)) {
    clearTimeout(pendingDisconnects.get(userId));
    pendingDisconnects.delete(userId);
  }
}

// ── Reconnect grace for PUBLIC arena lobbies ────────────────────────────
// Same problem as private lobbies: a background-tab disconnect during the
// 10s match countdown was dropping the player from lobby.players, then
// startMatch silently bailed because players.get(oldSid) === undefined.
// We delay the public-lobby leave too, and the connection handler re-seats
// the user when they come back.
const pendingPublicLeaves = new Map(); // userId → setTimeout

function schedulePublicLobbyLeave(io, userId) {
  if (pendingPublicLeaves.has(userId)) clearTimeout(pendingPublicLeaves.get(userId));
  const timer = setTimeout(() => {
    pendingPublicLeaves.delete(userId);
    const existing = findPublicLobbyForUser(userId);
    if (!existing) return;
    const sock = io.of('/shooter').sockets.get(existing.oldSid);
    if (sock) return; // they came back with the same id somehow
    // Actually leave: drop the slot, clear votes, cancel countdown.
    const { lobby, slot, oldSid } = existing;
    lobby.players.splice(slot, 1);
    delete lobby.mapVotes[oldSid];
    delete lobby.modeVotes[oldSid];
    delete lobby.roundsVotes[oldSid];
    if (lobby._startTimer) {
      clearTimeout(lobby._startTimer); lobby._startTimer = null;
      lobby.startsAt = null;
      io.of('/shooter').to(lobby.id).emit('match_countdown_cancel');
    }
    io.of('/shooter').to(lobby.id).emit('waiting_room_update', buildWaitingUpdate(lobby));
    broadcastLobbies(io);
  }, RECONNECT_GRACE_MS);
  pendingPublicLeaves.set(userId, timer);
}

function cancelPublicLobbyLeave(userId) {
  if (pendingPublicLeaves.has(userId)) {
    clearTimeout(pendingPublicLeaves.get(userId));
    pendingPublicLeaves.delete(userId);
  }
}

// ── Active-match reconnect grace ─────────────────────────────────────────
// Park a disconnected player for RECONNECT_MATCH_GRACE_MS; if they come
// back, tryResumeMatch re-keys their game state to the new socket id and
// re-emits match_start. If they don't, the timer falls through into the
// same forfeit logic the old code ran inline.
function scheduleMatchLeave(io, userId, oldSocketId, match) {
  // Reset the timer if the same user has stacked up a previous grace.
  const prior = pendingMatchReconnects.get(userId);
  if (prior) clearTimeout(prior.timer);

  // Freeze them out of the live tick — respawning=true is the existing
  // "ignore for damage and movement" flag. `disconnected` is purely for
  // UI / debugging.
  const st = match.gameState[oldSocketId];
  if (st) { st.respawning = true; st.disconnected = true; }

  const ns = io.of('/shooter');
  const deadlineAt = Date.now() + RECONNECT_MATCH_GRACE_MS;
  // Tell the still-connected players so the HUD can show a grace banner.
  for (const sid of match.playerIds) {
    if (sid !== oldSocketId) {
      ns.to(sid).emit('opponent_disconnect_grace', {
        socketId: oldSocketId, deadlineAt, graceMs: RECONNECT_MATCH_GRACE_MS,
      });
    }
  }
  Replay.log(match.id, 'reconnect_grace_start', { s: oldSocketId, ms: RECONNECT_MATCH_GRACE_MS });

  const timer = setTimeout(() => {
    pendingMatchReconnects.delete(userId);
    const m = matches.get(match.id);
    if (!m || m.ended) {
      // Match already concluded by other means — just clean up the
      // stranded player record.
      players.delete(oldSocketId);
      return;
    }
    Replay.log(m.id, 'reconnect_grace_expired', { s: oldSocketId });
    if (m.isTeamMatch) {
      const myTeam = m.gameState[oldSocketId]?.team;
      m.playerIds = m.playerIds.filter(id => id !== oldSocketId);
      delete m.gameState[oldSocketId];
      const remaining = Object.values(m.gameState).filter(s => s.team === myTeam).length;
      if (remaining === 0 && myTeam) {
        const otherTeam = myTeam === 'a' ? 'b' : 'a';
        endMatch(io, m.id, otherTeam, 'disconnect');
      } else {
        // Team still alive — just broadcast that the player is gone.
        for (const sid of m.playerIds) {
          ns.to(sid).emit('opponent_disconnect_final', { socketId: oldSocketId });
        }
      }
    } else {
      const opp = m.playerIds.find(id => id !== oldSocketId);
      endMatch(io, m.id, opp, 'disconnect');
    }
    players.delete(oldSocketId);
  }, RECONNECT_MATCH_GRACE_MS);

  pendingMatchReconnects.set(userId, { matchId: match.id, oldSocketId, timer, deadlineAt });
}

// Attempt to slot a returning socket back into its in-progress match.
// Returns the matchId on success, null when nothing was pending.
function tryResumeMatch(io, socket, userId) {
  const entry = pendingMatchReconnects.get(userId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingMatchReconnects.delete(userId);

  const match = matches.get(entry.matchId);
  if (!match || match.ended) {
    // Match died while they were gone — release the stranded record.
    players.delete(entry.oldSocketId);
    return null;
  }
  const oldSid = entry.oldSocketId;
  const newSid = socket.id;
  const st = match.gameState[oldSid];
  if (!st) {
    players.delete(oldSid);
    return null;
  }

  // Re-key the game state, playerIds list, and any per-socket maps.
  match.gameState[newSid] = st;
  delete match.gameState[oldSid];
  match.playerIds = match.playerIds.map(id => id === oldSid ? newSid : id);

  // Respawn cleanly: full health, fresh position, no leftover respawning flag.
  st.disconnected = false;
  st.respawning = false;
  st.health = MAX_HEALTH;
  const myIdx = match.playerIds.indexOf(newSid);
  if (match.spawnPoints?.[myIdx]) {
    st.position = { ...match.spawnPoints[myIdx] };
    st.lastPosition = { ...match.spawnPoints[myIdx] };
    st.positionHistory = [];
  }
  // Refill ammo / throwables so they aren't dropped back in empty-handed.
  for (const k of Object.keys(WEAPONS)) {
    if (st.weapons?.[k]) {
      st.weapons[k].ammo = WEAPONS[k].mag;
      st.weapons[k].reloading = false;
    }
  }
  refillThrowables(st);
  st.lastShot = 0;
  st.lastWeaponSwitchAt = 0;

  // Sweep out the old player record; the new connection has already
  // created a fresh one keyed by newSid (with currentMatch=null), which
  // we patch below.
  players.delete(oldSid);
  const playerRec = players.get(newSid);
  if (playerRec) playerRec.currentMatch = match.id;

  // Build a fresh players payload keyed by the *current* socket ids so the
  // client can render team labels / name tags correctly.
  const playersPayload = {};
  for (const sid of match.playerIds) {
    const pr = players.get(sid);
    if (!pr) continue;
    playersPayload[sid] = {
      username: pr.username,
      spawnIndex: match.playerIds.indexOf(sid),
      // gameState carries the team in team mode; leave undefined for 1v1.
      team: match.gameState[sid]?.team,
    };
  }

  const ns = io.of('/shooter');
  ns.to(newSid).emit('match_start', {
    matchId: match.id,
    mapType: match.mapType,
    mapName: match.mapName,
    arenaSize: match.arenaSize,
    coverBoxes: match.coverBoxes,
    spawnPoints: match.spawnPoints,
    endTime: match.endTime,
    weaponMode: match.weaponMode,
    killsToWin: match.killsToWin,
    economy: match.economy, econ: match.economy ? ECON_PUBLIC : null,
    wallet: match.economy ? econPlayerSnapshot(match.gameState[newSid]) : null,
    players: playersPayload,
    yourId: newSid,
    resumed: true,
  });
  // Let the other player(s) know the disconnected player is back so any
  // "Opponent disconnected" banner can clear.
  for (const sid of match.playerIds) {
    if (sid !== newSid) {
      ns.to(sid).emit('opponent_reconnected', { socketId: newSid });
    }
  }
  Replay.log(match.id, 'reconnect_grace_resumed', { oldSid, newSid });
  return match.id;
}

// ── Public matchmaking queues ────────────────────────────────────────────
// Per (tier, teamSize) bucket. Each bucket holds zero or more "teams" in
// formation; once a team fills it goes 'full', and as soon as a second
// 'full' team exists in the same bucket the pair is countdowned into a
// match. This replaces the old "pre-defined 2-slot tier lobby" model so
// the same flow handles 1v1, 2v2, 4v4, and 5v5.
const PUBLIC_FORMATS = [1, 2, 4, 5];
const MM_COUNTDOWN_MS = 5000;
const mmQueues       = new Map();  // "tier:size" → queue
const mmTeamById     = new Map();  // teamId → team
const mmTeamBySocket = new Map();  // socketId → teamId
let _mmTeamSeq = 0;

function mmQueueKey(tier, size) { return `${tier}:${size}`; }
function getMmQueue(tier, size) {
  const key = mmQueueKey(tier, size);
  if (!mmQueues.has(key)) {
    const def = LOBBY_DEFS.find(l => l.id === tier);
    mmQueues.set(key, { tier, teamSize: size, bet: def?.bet || 0, teams: [] });
  }
  return mmQueues.get(key);
}
function mkMmTeam(tier, size, bet) {
  _mmTeamSeq++;
  const t = {
    id: `mm_${Date.now()}_${_mmTeamSeq}`,
    tier, teamSize: size, bet,
    members: [],
    status: 'forming',          // 'forming' | 'full' | 'paired'
    createdAt: Date.now(),
    countdownTimer: null,
    // Per-socket votes — tallied across both teams at startMmMatch.
    mapVotes:    Object.create(null),    // socketId → 'symmetrical'|'random'|'cs_depot'
    modeVotes:   Object.create(null),    // socketId → 'all'|'rifle'|...
    roundsVotes: Object.create(null),    // socketId → 3|5|7
    // Outstanding friend invites we sent. Map<userId, { timer, fromSocketId }>.
    pendingInvites: new Map(),
  };
  mmTeamById.set(t.id, t);
  return t;
}
function broadcastMmTeam(io, team) {
  const payload = {
    teamId:   team.id,
    tier:     team.tier,
    teamSize: team.teamSize,
    bet:      team.bet,
    status:   team.status,
    members:  team.members.map(m => ({ socketId: m.socketId, username: m.username })),
    // Include all votes so each client can render the live tally AND
    // highlight its own selection.
    votes: {
      map:    { ...team.mapVotes },
      mode:   { ...team.modeVotes },
      rounds: { ...team.roundsVotes },
    },
  };
  const ns = io.of('/shooter');
  for (const m of team.members) ns.to(m.socketId).emit('mm_team_update', payload);
}

// Find a connected /shooter socket by userId. Used for friend invites
// so we only invite friends actually present on the shooter page.
function findShooterSocketByUserId(io, userId) {
  const ns = io.of('/shooter');
  for (const [sid, sock] of ns.sockets) {
    if (sock?.data?.userId === userId) return sid;
  }
  return null;
}

function teamOfSocket(socketId) {
  const teamId = mmTeamBySocket.get(socketId);
  return teamId ? mmTeamById.get(teamId) : null;
}

// Look up whether two users are accepted friends — used to gate the
// invite endpoint so a random user can't spam invites.
async function areFriends(userA, userB) {
  if (!userA || !userB || userA === userB) return false;
  const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'`,
      [a, b]
    );
    return rows.length > 0;
  } catch (_) { return false; }
}
function removeFromMm(io, socketId, opts = {}) {
  const teamId = mmTeamBySocket.get(socketId);
  if (!teamId) return;
  mmTeamBySocket.delete(socketId);
  const team = mmTeamById.get(teamId);
  if (!team) return;
  team.members = team.members.filter(m => m.socketId !== socketId);
  // Strip the leaver's votes so the tally reflects the current team.
  delete team.mapVotes[socketId];
  delete team.modeVotes[socketId];
  delete team.roundsVotes[socketId];
  // Empty team → remove from queue + registry.
  if (team.members.length === 0) {
    const q = getMmQueue(team.tier, team.teamSize);
    q.teams = q.teams.filter(t => t.id !== team.id);
    if (team.countdownTimer) { clearTimeout(team.countdownTimer); team.countdownTimer = null; }
    // Cancel any outstanding friend invites — the team they were
    // invited to no longer exists.
    for (const inv of team.pendingInvites.values()) {
      try { clearTimeout(inv.timer); } catch (_) {}
    }
    team.pendingInvites.clear();
    mmTeamById.delete(team.id);
    return;
  }
  // Downgrade from full/paired (rare — disconnect mid-countdown).
  if (team.status === 'paired' && team.countdownTimer) {
    clearTimeout(team.countdownTimer);
    team.countdownTimer = null;
    team.status = 'forming';
    // Cancel the countdown on the other side too — best-effort.
    const q = getMmQueue(team.tier, team.teamSize);
    for (const other of q.teams) {
      if (other.id !== team.id && other.status === 'paired' && other.countdownTimer) {
        clearTimeout(other.countdownTimer);
        other.countdownTimer = null;
        other.status = 'full';
        const ns = io.of('/shooter');
        for (const m of other.members) {
          ns.to(m.socketId).emit('mm_pair_cancelled', { reason: 'partner_left' });
        }
        broadcastMmTeam(io, other);
        // Try to find a different partner for `other`.
        tryPairMm(io, q);
      }
    }
  } else if (team.status === 'full') {
    team.status = 'forming';
  }
  if (!opts.silent) broadcastMmTeam(io, team);
}

function joinMm(io, socket, tier, teamSize) {
  if (!PUBLIC_FORMATS.includes(teamSize)) return { error: 'invalid_format' };
  const def = LOBBY_DEFS.find(l => l.id === tier);
  if (!def) return { error: 'no_tier' };
  if (mmTeamBySocket.has(socket.id)) return { error: 'already_in_queue' };
  const p = players.get(socket.id);
  if (!p) return { error: 'not_ready' };
  if (p.currentMatch) return { error: 'already_in_match' };
  if (p.currentLobby) return { error: 'already_in_lobby' };
  if (p.privateLobby) return { error: 'in_private_lobby' };

  const queue = getMmQueue(tier, teamSize);
  // Slot into the oldest forming team that still has room.
  let team = queue.teams.find(t => t.status === 'forming' && t.members.length < teamSize);
  if (!team) {
    team = mkMmTeam(tier, teamSize, def.bet);
    queue.teams.push(team);
  }
  team.members.push({ socketId: socket.id, userId: p.userId, username: p.username });
  mmTeamBySocket.set(socket.id, team.id);
  if (team.members.length >= teamSize) team.status = 'full';
  broadcastMmTeam(io, team);
  if (team.status === 'full') tryPairMm(io, queue);
  return { ok: true, teamId: team.id, status: team.status };
}

function tryPairMm(io, queue) {
  const fulls = queue.teams.filter(t => t.status === 'full');
  if (fulls.length < 2) return;
  fulls.sort((a, b) => a.createdAt - b.createdAt);
  const teamA = fulls[0], teamB = fulls[1];
  const startsAt = Date.now() + MM_COUNTDOWN_MS;
  for (const team of [teamA, teamB]) {
    team.status = 'paired';
    const ns = io.of('/shooter');
    for (const m of team.members) {
      ns.to(m.socketId).emit('mm_match_countdown', {
        startsAt, ms: MM_COUNTDOWN_MS,
        tier: team.tier, teamSize: team.teamSize, bet: team.bet,
        enemySize: (team === teamA ? teamB : teamA).teamSize,
      });
    }
  }
  teamA.countdownTimer = setTimeout(() => startMmMatch(io, queue, teamA, teamB), MM_COUNTDOWN_MS);
}

async function startMmMatch(io, queue, teamA, teamB) {
  // Remove both teams from the queue and clear member→team links.
  queue.teams = queue.teams.filter(t => t.id !== teamA.id && t.id !== teamB.id);
  for (const m of [...teamA.members, ...teamB.members]) {
    mmTeamBySocket.delete(m.socketId);
  }
  // Cancel any pending friend-invite timers — invitees can no longer
  // join this team since the match is starting.
  for (const team of [teamA, teamB]) {
    for (const inv of team.pendingInvites.values()) {
      try { clearTimeout(inv.timer); } catch (_) {}
    }
    team.pendingInvites.clear();
  }
  mmTeamById.delete(teamA.id);
  mmTeamById.delete(teamB.id);
  teamA.countdownTimer = teamB.countdownTimer = null;

  const ns = io.of('/shooter');
  const teamSize = teamA.teamSize;
  const tier     = teamA.tier;
  const bet      = teamA.bet;
  const allMembers = [...teamA.members.map(m => ({ ...m, team: 'a' })),
                      ...teamB.members.map(m => ({ ...m, team: 'b' }))];

  // Combine votes from BOTH teams — every player gets one vote each.
  // Falls back to defaults inside the resolve* helpers if nobody voted.
  const combinedMap = {
    ...teamA.mapVotes, ...teamB.mapVotes,
  };
  const combinedMode = {
    ...teamA.modeVotes, ...teamB.modeVotes,
  };
  const combinedRounds = {
    ...teamA.roundsVotes, ...teamB.roundsVotes,
  };
  const resolvedMap    = resolveMapType(combinedMap);
  const resolvedMode   = resolveWeaponMode(combinedMode);
  const resolvedRounds = resolveRounds(combinedRounds);

  // Wallet escrow — uses the existing team path even for teamSize=1, so
  // a 1v1 match from the queue still uses game_sessions (no shooter_sessions
  // row). That keeps the queue path uniform across all sizes.
  let dbResult;
  try {
    dbResult = await startTeamShooterMatch(
      teamA.members.map(m => m.userId),
      teamB.members.map(m => m.userId),
      bet,
    );
  } catch (e) {
    console.error('[mm] wallet escrow failed', e);
    for (const m of allMembers) ns.to(m.socketId).emit('match_error', { error: e.message });
    return;
  }

  // Map / weapon mode / kills-to-win come from the combined vote tally.
  // The resolve* helpers default to symmetrical / all / 5 if nobody voted.
  const map         = buildMapByType(resolvedMap);
  const mapType     = map.mapType;
  const mapName     = map.mapName;
  const arenaSize   = map.arenaSize;
  const coverBoxes  = map.coverBoxes;
  const baseSpawns  = map.spawnPoints;
  // Spread teammates along the team's spawn line so they aren't stacked.
  const spawnFor = (team, idx) => {
    const xs = [-4, 0, 4, -8, 8];
    const base = team === 'a' ? baseSpawns[0] : baseSpawns[1];
    return { x: xs[idx % xs.length], y: 0, z: base?.z ?? (team === 'a' ? 17 : -17) };
  };
  const defaultWeapon = (resolvedMode === 'all') ? DEFAULT_WEAPON : resolvedMode;

  const now = Date.now();
  const mkState = (team, spawnIdx) => ({
    position: { ...spawnFor(team, spawnIdx) },
    rotation: { x: 0, y: team === 'a' ? Math.PI : 0 },
    health: MAX_HEALTH, kills: 0, deaths: 0, headshots: 0,
    shotsFired: 0, shotsHit: 0,
    weapon: defaultWeapon,
    weapons: Object.fromEntries(
      Object.keys(WEAPONS).map(k => [k, { ammo: WEAPONS[k].mag, reloading: false, reloadStartedAt: 0 }])
    ),
    lastShot: 0, positionHistory: [], respawning: false,
    lastPosition: { ...spawnFor(team, spawnIdx) },
    lastMoveAt: now, lastWeaponSwitchAt: 0, suspiciousScore: 0,
    team,
    throwables: mkThrowables(),
    selectedThrowable: 'molotov',
    lastThrowAt: 0,
  });

  const gameState = {};
  const playerIds = [];
  teamA.members.forEach((m, i) => { gameState[m.socketId] = mkState('a', i); playerIds.push(m.socketId); });
  teamB.members.forEach((m, i) => { gameState[m.socketId] = mkState('b', i); playerIds.push(m.socketId); });

  const match = {
    id: dbResult.sessionId,
    dbMatchId: null,
    sessionId: dbResult.sessionId,
    lobbyId: tier,                  // for replay / logs
    playerIds,
    mapType, mapName, arenaSize, coverBoxes,
    spawnPoints: playerIds.map(sid => ({ ...gameState[sid].position })),
    startTime: now, endTime: now + MATCH_DURATION_MS,
    status: 'active',
    gameState,
    betAmount: bet,
    ended: false,
    coverAabbs: coverBoxes.map(coverAabb),
    weaponMode: resolvedMode,
    killsToWin: resolvedRounds,
    isTeamMatch: true,
    teamSize,
    teamScores: { a: 0, b: 0 },
    teamsByUserId: Object.fromEntries(allMembers.map(m => [m.userId, m.team])),
  };
  matches.set(match.id, match);
  ensureThrowableTick(io, match);
  initMatchEconomy(match);
  for (const sid of playerIds) {
    const p = players.get(sid);
    if (p) p.currentMatch = match.id;
  }

  Replay.start(match.id, dbResult.sessionId, {
    lobbyId: tier, bet, mapType,
    players: Object.fromEntries(playerIds.map(sid => {
      const p = players.get(sid);
      return [sid, { userId: p?.userId, username: p?.username, spawnIndex: playerIds.indexOf(sid) }];
    })),
  });
  for (const sid of playerIds) {
    Replay.log(match.id, 'player_spawn', { s: sid, p: gameState[sid].position });
  }

  const basePayload = {
    matchId: match.id, mapType,
    mapName, arenaSize,
    coverBoxes, spawnPoints: match.spawnPoints,
    endTime: match.endTime,
    weaponMode: resolvedMode, killsToWin: resolvedRounds,
    isTeamMatch: true, teamSize,
    economy: match.economy, econ: match.economy ? ECON_PUBLIC : null,
    players: Object.fromEntries(playerIds.map((sid, i) => {
      const p = players.get(sid);
      return [sid, { username: p?.username || '?', team: gameState[sid].team, spawnIndex: i }];
    })),
  };
  for (const sid of playerIds) {
    ns.to(sid).emit('match_start', {
      ...basePayload, yourId: sid, yourTeam: gameState[sid].team,
      wallet: match.economy ? econPlayerSnapshot(gameState[sid]) : null,
    });
  }

  match.timeoutTimer = setTimeout(() => {
    if (matches.has(match.id) && !match.ended) endMatch(io, match.id, null, 'timeout');
  }, MATCH_DURATION_MS);
}

// Settings change → clear ready states for everyone except the host (the
// host implicitly accepts whatever they just chose). Used whenever the
// host changes bet / mode / size / kills / etc.
function unreadyNonHost(lobby) {
  for (const m of lobby.members) {
    if (m.userId !== lobby.hostUserId) m.ready = false;
  }
}

// Disband a private lobby and notify all members.
function disbandPrivateLobby(io, lobby, reason) {
  if (!lobby) return;
  io.of('/shooter').to('priv:' + lobby.id).emit('private_lobby_disbanded', { reason });
  for (const m of lobby.members) {
    const p = m.socketId ? players.get(m.socketId) : null;
    if (p) p.privateLobby = null;
    const sock = io.of('/shooter').sockets.get(m.socketId);
    sock?.leave('priv:' + lobby.id);
  }
  privateLobbies.delete(lobby.id);
  if (lobby.inviteCode) privateLobbiesByCode.delete(lobby.inviteCode);
}

function handleLeavePrivate(socket, reason = 'left') {
  const me = players.get(socket.id);
  if (!me?.privateLobby) return;
  const lobby = privateLobbies.get(me.privateLobby);
  me.privateLobby = null;
  socket.leave('priv:' + (lobby?.id || ''));
  if (!lobby) return;
  // Only handle pre-match leaves here. In-match disconnects go through
  // the existing match handleLeave forfeit path.
  if (lobby.status !== 'waiting' && lobby.status !== 'ready') return;

  const wasHost = lobby.hostUserId === me.userId;
  lobby.members = lobby.members.filter(m => m.socketId !== socket.id);

  if (!lobby.members.length) {
    disbandPrivateLobby(socket.server, lobby, reason);
    return;
  }
  if (wasHost) {
    // Transfer host to the first remaining CONNECTED member; if none,
    // disband instead so the lobby doesn't get stranded.
    const next = lobby.members.find(m => m.socketId && players.has(m.socketId))
                 || lobby.members[0];
    if (!next || !next.socketId || !players.has(next.socketId)) {
      disbandPrivateLobby(socket.server, lobby, 'host_left');
      return;
    }
    lobby.hostUserId   = next.userId;
    lobby.hostSocketId = next.socketId;
    // Settings changed effectively (new host) — clear ready states.
    unreadyNonHost(lobby);
    socket.server.of('/shooter').to('priv:' + lobby.id).emit('host_transferred', {
      newHostUserId: next.userId, newHostUsername: next.username,
    });
  }
  // Lobby moves back to 'waiting' if it was already 'ready' but now needs players.
  if (lobby.status === 'ready') lobby.status = 'waiting';
  broadcastPrivateLobbyUpdate(socket.server, lobby);
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
    if (lobby.inviteCode) privateLobbiesByCode.delete(lobby.inviteCode);
    throw e;
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
    throwables: mkThrowables(),
    selectedThrowable: 'molotov',
    lastThrowAt: 0,
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
  ensureThrowableTick(io, match);
  initMatchEconomy(match);

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

  // Tell every player the match started. Team matches still use the
  // legacy 40x40 symmetrical arena for safety — adding Depot here can
  // come later once we have time to balance spawns for 6+ players.
  const basePayload = {
    matchId: match.id, mapType,
    mapName: 'Symmetrical', arenaSize: 40,
    coverBoxes,
    spawnPoints: match.spawnPoints,
    endTime: match.endTime,
    weaponMode: lobby.weaponMode,
    killsToWin: lobby.killsToWin,
    isTeamMatch: true,
    teamSize: lobby.teamSize,
    economy: match.economy, econ: match.economy ? ECON_PUBLIC : null,
    players: Object.fromEntries(allMembers.map((m, i) => [m.socketId, {
      username: m.username, team: m.team, spawnIndex: i,
    }])),
  };
  for (const m of allMembers) {
    ns.to(m.socketId).emit('match_start', {
      ...basePayload, yourId: m.socketId, yourTeam: m.team,
      wallet: match.economy ? econPlayerSnapshot(match.gameState[m.socketId]) : null,
    });
  }
  // Match timer
  match.timeoutTimer = setTimeout(() => {
    if (matches.has(match.id) && !match.ended) endMatch(io, match.id, null, 'timeout');
  }, MATCH_DURATION_MS);

  privateLobbies.delete(lobby.id);
  if (lobby.inviteCode) privateLobbiesByCode.delete(lobby.inviteCode);
}

async function startMatch(io, lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;
  const ns = io.of('/shooter');

  try { return await _startMatchInner(io, lobby); }
  catch (err) {
    console.error('[shooter] startMatch failed', err);
    ns.to(lobby.id).emit('match_error', { error: err.message || 'start_failed' });
    resetPublicLobby(lobby);
    broadcastLobbies(io);
  }
}

async function _startMatchInner(io, lobby) {
  const ns = io.of('/shooter');
  // The connection handler patches stale socket ids on reconnect, so
  // lobby.players is always current here. We just verify both slots
  // resolve to a live player; if not, emit match_error and reset.
  if (lobby.players.length !== 2) {
    ns.to(lobby.id).emit('match_error', { error: 'lobby_empty' });
    resetPublicLobby(lobby);
    broadcastLobbies(io);
    return;
  }
  const [p1Id, p2Id] = lobby.players;
  const p1 = players.get(p1Id);
  const p2 = players.get(p2Id);
  if (!p1 || !p2) {
    ns.to(lobby.id).emit('match_error', { error: 'player_disconnected' });
    resetPublicLobby(lobby);
    broadcastLobbies(io);
    return;
  }
  const lobbyId = lobby.id;

  const mapType   = resolveMapType(lobby.mapVotes);
  const mapDef    = buildMapByType(mapType);
  const coverBoxes  = mapDef.coverBoxes;
  const spawnPoints = mapDef.spawnPoints;
  const arenaSize   = mapDef.arenaSize;
  const mapName     = mapDef.mapName;
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
    resetPublicLobby(lobby);
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
    // Throwables — refilled on every respawn.
    throwables: mkThrowables(),
    selectedThrowable: 'molotov',
    lastThrowAt: 0,
  });

  const match = {
    id: dbResult.matchId,
    dbMatchId: dbResult.matchId,
    sessionId: dbResult.sessionId,
    lobbyId,
    playerIds: [p1Id, p2Id],
    mapType, mapName, arenaSize, coverBoxes, spawnPoints,
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
  ensureThrowableTick(io, match);
  initMatchEconomy(match);
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
  ns.sockets.get(p1Id)?.leave(lobbyId);
  ns.sockets.get(p2Id)?.leave(lobbyId);
  broadcastLobbies(io);

  const basePayload = {
    matchId: match.id, mapType, mapName, arenaSize,
    coverBoxes, spawnPoints,
    endTime: match.endTime,
    weaponMode, killsToWin,
    economy: match.economy, econ: match.economy ? ECON_PUBLIC : null,
    players: {
      [p1Id]: { username: p1.username, spawnIndex: 0 },
      [p2Id]: { username: p2.username, spawnIndex: 1 },
    },
  };
  io.of('/shooter').to(p1Id).emit('match_start', {
    ...basePayload, yourId: p1Id,
    wallet: match.economy ? econPlayerSnapshot(match.gameState[p1Id]) : null,
  });
  io.of('/shooter').to(p2Id).emit('match_start', {
    ...basePayload, yourId: p2Id,
    wallet: match.economy ? econPlayerSnapshot(match.gameState[p2Id]) : null,
  });

  // Match timer — draw if no winner by deadline
  match.timeoutTimer = setTimeout(() => {
    if (matches.has(match.id) && !match.ended) endMatch(io, match.id, null, 'timeout');
  }, MATCH_DURATION_MS);
}

function attach(io) {
  _ioRef = io;            // module-level so noteSuspicious can forfeit
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
      const playerRec = {
        id: socket.id, userId, username,
        currentLobby: null, currentMatch: null,
      };
      // If this user was already in a private lobby (host just reloaded,
      // network blip, etc.), restore their membership and rejoin them
      // to the room so live updates resume without a refresh.
      const existing = findPrivateLobbyForUser(userId);
      if (existing) {
        // Cancel any pending "leave due to disconnect" — they came back.
        cancelLeavePrivate(userId);
        playerRec.privateLobby = existing.lobby.id;
        existing.member.socketId = socket.id;
        if (existing.lobby.hostUserId === userId) existing.lobby.hostSocketId = socket.id;
        socket.join('priv:' + existing.lobby.id);
      }
      // Same restore for PUBLIC arena lobbies — re-seat the user in
      // their slot if their old socket id is still parked there, so a
      // background-tab disconnect during the 10s countdown doesn't
      // strand them once the countdown fires.
      const pub = findPublicLobbyForUser(userId);
      if (pub) {
        cancelPublicLobbyLeave(userId);
        // Patch the slot to the new socket id and migrate vote state.
        pub.lobby.players[pub.slot] = socket.id;
        for (const map of [pub.lobby.mapVotes, pub.lobby.modeVotes, pub.lobby.roundsVotes]) {
          if (map[pub.oldSid] !== undefined) { map[socket.id] = map[pub.oldSid]; delete map[pub.oldSid]; }
        }
        playerRec.currentLobby = pub.lobby.id;
        socket.join(pub.lobby.id);
      }
      players.set(socket.id, playerRec);
      socket.emit('shooter_ready', {
        lobbies: lobbySnapshot(),
        ranking: liveStats,
        requirements: Ranking.LOBBY_REQUIREMENTS,
        // If we restored a lobby for them, hand the snapshot straight back
        // so the UI shows the current state without any extra round-trip.
        privateLobby: existing ? snapshotPrivate(existing.lobby) : null,
      });
      // Active-match reconnect: if this user had a 10s grace pending,
      // re-key their game state to this socket and re-emit match_start
      // (with resumed:true) so the client can jump straight back into
      // the live match — no forfeit, no rematch.
      tryResumeMatch(io, socket, userId);
      if (existing) broadcastPrivateLobbyUpdate(io, existing.lobby);
    }).catch(err => {
      console.error('[shooter] connection setup failed', err);
      socket.emit('shooter_ready', { lobbies: lobbySnapshot() });
    });

    // Client-driven re-sync of lobby state. Used as a backup if the
    // initial broadcast on reconnect was missed.
    socket.on('request_lobby_state', (_, cb) => {
      const me = players.get(socket.id);
      // Even if their player record doesn't currently link to a private
      // lobby (e.g. fresh connection after a refresh), try to find one
      // by userId so the grace-period reconnect path still works.
      const userId = me?.userId || socket.data?.userId;
      if (!userId) return cb?.({ ok: true, lobby: null });
      cancelLeavePrivate(userId);
      const existing = findPrivateLobbyForUser(userId);
      if (!existing) {
        if (me) me.privateLobby = null;
        return cb?.({ ok: true, lobby: null });
      }
      // Refresh stored socket id & make sure the room subscription is live.
      existing.member.socketId = socket.id;
      if (existing.lobby.hostUserId === userId) existing.lobby.hostSocketId = socket.id;
      if (me) me.privateLobby = existing.lobby.id;
      socket.join('priv:' + existing.lobby.id);
      cb?.({ ok: true, lobby: snapshotPrivate(existing.lobby) });
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
          // startMatch owns its own try/catch + match_error emit — no
          // wrapper needed here.
          startMatch(io, lobbyId);
        }, COUNTDOWN_MS);
      }
    });

    socket.on('vote_map', ({ mapType } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentLobby) return;
      if (!MAP_TYPES.includes(mapType)) return;
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
        if (me.currentLobby || me.currentMatch) return cb?.({ error: 'busy' });
        const ts = Number(teamSize);
        if (!TEAM_SIZES.includes(ts)) return cb?.({ error: 'bad_team_size' });
        const b  = Math.max(1, Math.floor(Number(bet) || 50));
        const wm = WEAPON_MODES.includes(weaponMode) ? weaponMode : 'all';
        const kw = ROUND_OPTIONS.includes(Number(killsToWin)) ? Number(killsToWin) : 5;
        // Host must have the bet on hand to escrow later.
        const bal = await getBalance(me.userId);
        if (bal < b) return cb?.({ error: 'insufficient_balance' });

        const lobbyId   = 'p-' + Math.random().toString(36).slice(2, 10);
        const inviteCode = generateInviteCode();
        const lobby = {
          id: lobbyId,
          inviteCode,
          hostUserId: me.userId,
          hostSocketId: socket.id,
          teamSize: ts,
          mode: ts === 1 ? 'duel' : 'team',
          bet: b,
          weaponMode: wm,
          killsToWin: kw,
          members: [{
            socketId: socket.id, userId: me.userId, username: me.username,
            team: 'a', ready: true, // host is implicitly ready
          }],
          invitedUserIds: new Set(),
          status: 'waiting',
          createdAt: Date.now(),
        };
        privateLobbies.set(lobbyId, lobby);
        privateLobbiesByCode.set(inviteCode, lobbyId);
        me.privateLobby = lobbyId;
        socket.join('priv:' + lobbyId);
        cb?.({ ok: true, lobby: snapshotPrivate(lobby) });
        broadcastPrivateLobbyUpdate(io, lobby);
      } catch (e) {
        cb?.({ error: e.message || 'create_failed' });
      }
    });

    // Send invite to a friend via the /chat namespace.
    socket.on('invite_to_lobby', async ({ friendUserId } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
        const lobby = privateLobbies.get(me.privateLobby);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
        if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
        if (lobby.members.length >= lobby.teamSize * 2) return cb?.({ error: 'lobby_full' });
        if (friendUserId === me.userId) return cb?.({ error: 'cant_invite_self' });
        if (lobby.members.some(m => m.userId === friendUserId)) return cb?.({ error: 'already_in_lobby' });

        const [a, b] = me.userId < friendUserId ? [me.userId, friendUserId] : [friendUserId, me.userId];
        const { rows } = await pool.query(
          `SELECT 1 FROM friendships WHERE user_a=$1 AND user_b=$2 AND status='accepted'`,
          [a, b]
        );
        if (!rows.length) return cb?.({ error: 'not_friends' });

        lobby.invitedUserIds.add(friendUserId);
        io.of('/chat').to(`u:${friendUserId}`).emit('lobby_invite', {
          lobbyId: lobby.id,
          code: lobby.inviteCode,
          fromUserId: me.userId,
          fromUsername: me.username,
          teamSize: lobby.teamSize,
          mode: lobby.mode,
          bet: lobby.bet,
          weaponMode: lobby.weaponMode,
          killsToWin: lobby.killsToWin,
        });
        cb?.({ ok: true });
      } catch (e) { cb?.({ error: e.message || 'invite_failed' }); }
    });

    // Joined via the invite toast (lobbyId supplied) or by code.
    socket.on('accept_invite', async ({ lobbyId, code } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me) return cb?.({ error: 'not_ready' });
        if (me.privateLobby) return cb?.({ error: 'already_in_lobby' });
        if (me.currentLobby || me.currentMatch) return cb?.({ error: 'busy' });

        // Resolve the lobby — code wins if both supplied.
        let lobby = null;
        if (code) {
          const id = privateLobbiesByCode.get(String(code).toUpperCase());
          if (id) lobby = privateLobbies.get(id);
        }
        if (!lobby && lobbyId) lobby = privateLobbies.get(lobbyId);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
        if (lobby.members.length >= lobby.teamSize * 2) return cb?.({ error: 'lobby_full' });

        const bal = await getBalance(me.userId);
        if (bal < lobby.bet) return cb?.({ error: 'insufficient_balance' });

        const teamA = lobby.members.filter(m => m.team === 'a').length;
        const teamB = lobby.members.filter(m => m.team === 'b').length;
        const team  = teamA <= teamB ? 'a' : 'b';
        lobby.members.push({
          socketId: socket.id, userId: me.userId, username: me.username,
          team, ready: false,
        });
        lobby.invitedUserIds.delete(me.userId);
        me.privateLobby = lobby.id;
        socket.join('priv:' + lobby.id);
        cb?.({ ok: true, lobby: snapshotPrivate(lobby) });
        broadcastPrivateLobbyUpdate(io, lobby);
      } catch (e) { cb?.({ error: e.message || 'join_failed' }); }
    });

    // Friend tapped Decline on the toast — let the host know if possible.
    socket.on('decline_invite', ({ lobbyId, fromUserId } = {}) => {
      try {
        const me = players.get(socket.id);
        if (!me) return;
        const lobby = lobbyId ? privateLobbies.get(lobbyId) : null;
        if (!lobby) return;
        lobby.invitedUserIds.delete(me.userId);
        // Tell every host-side socket in this lobby's room.
        io.of('/shooter').to('priv:' + lobby.id).emit('invite_declined', {
          fromUserId: me.userId, fromUsername: me.username,
        });
      } catch (_) {}
    });

    // Join by short code (typed in the lobby UI).
    socket.on('join_by_code', async ({ code } = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me) return cb?.({ error: 'not_ready' });
        if (me.privateLobby) return cb?.({ error: 'already_in_lobby' });
        if (me.currentLobby || me.currentMatch) return cb?.({ error: 'busy' });
        const C = String(code || '').trim().toUpperCase();
        if (!C) return cb?.({ error: 'bad_code' });
        const id = privateLobbiesByCode.get(C);
        if (!id) return cb?.({ error: 'no_lobby' });
        // Reuse the accept-invite validation inline so the path stays
        // in one place.
        return new Promise((resolve) => {
          // Inline the accept logic so the code path is shared.
          (async () => {
            const lobby = privateLobbies.get(id);
            if (!lobby) return cb?.({ error: 'no_lobby' });
            if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
            if (lobby.members.length >= lobby.teamSize * 2) return cb?.({ error: 'lobby_full' });
            const bal = await getBalance(me.userId);
            if (bal < lobby.bet) return cb?.({ error: 'insufficient_balance' });
            const tA = lobby.members.filter(m => m.team === 'a').length;
            const tB = lobby.members.filter(m => m.team === 'b').length;
            const team = tA <= tB ? 'a' : 'b';
            lobby.members.push({
              socketId: socket.id, userId: me.userId, username: me.username,
              team, ready: false,
            });
            me.privateLobby = lobby.id;
            socket.join('priv:' + lobby.id);
            cb?.({ ok: true, lobby: snapshotPrivate(lobby) });
            broadcastPrivateLobbyUpdate(io, lobby);
            resolve();
          })().catch(e => cb?.({ error: e.message || 'join_failed' }));
        });
      } catch (e) { cb?.({ error: e.message || 'join_failed' }); }
    });

    socket.on('leave_private_lobby', (_, cb) => {
      handleLeavePrivate(socket, 'left');
      cb?.({ ok: true });
    });

    // Ready / unready toggle (any member).
    socket.on('set_ready', ({ ready } = {}, cb) => {
      const me = players.get(socket.id);
      if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
      const lobby = privateLobbies.get(me.privateLobby);
      if (!lobby) return cb?.({ error: 'no_lobby' });
      if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
      const mem = lobby.members.find(m => m.userId === me.userId);
      if (!mem) return cb?.({ error: 'not_member' });
      mem.ready = !!ready;
      // Update derived status.
      const { allOk } = lobbyReadiness(lobby);
      lobby.status = allOk ? 'ready' : 'waiting';
      cb?.({ ok: true });
      broadcastPrivateLobbyUpdate(io, lobby);
    });

    // Switch teams (any non-host while waiting; host can also move themselves).
    socket.on('switch_team', ({ team } = {}, cb) => {
      const me = players.get(socket.id);
      if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
      const lobby = privateLobbies.get(me.privateLobby);
      if (!lobby) return cb?.({ error: 'no_lobby' });
      if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
      if (team !== 'a' && team !== 'b') return cb?.({ error: 'bad_team' });
      const mem = lobby.members.find(m => m.userId === me.userId);
      if (!mem) return cb?.({ error: 'not_member' });
      if (mem.team === team) return cb?.({ ok: true });
      const sideCount = lobby.members.filter(m => m.team === team).length;
      if (sideCount >= lobby.teamSize) return cb?.({ error: 'team_full' });
      mem.team  = team;
      mem.ready = false;
      // Other side stays as-is. Settings change = unready everyone non-host
      // on this team swap as well, since composition changed.
      unreadyNonHost(lobby);
      lobby.status = 'waiting';
      cb?.({ ok: true });
      broadcastPrivateLobbyUpdate(io, lobby);
    });

    // Host changes any lobby setting. Resets ready states for non-host.
    socket.on('change_lobby_settings', async (settings = {}, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
        const lobby = privateLobbies.get(me.privateLobby);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
        if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });

        let changed = false;
        if (settings.teamSize != null) {
          const ts = Number(settings.teamSize);
          if (!TEAM_SIZES.includes(ts)) return cb?.({ error: 'bad_team_size' });
          // Shrinking below current member count is not allowed.
          if (lobby.members.length > ts * 2) return cb?.({ error: 'too_many_members' });
          if (ts !== lobby.teamSize) {
            lobby.teamSize = ts;
            lobby.mode     = ts === 1 ? 'duel' : 'team';
            changed = true;
          }
        }
        if (settings.weaponMode != null) {
          if (!WEAPON_MODES.includes(settings.weaponMode)) return cb?.({ error: 'bad_weapon_mode' });
          if (settings.weaponMode !== lobby.weaponMode) {
            lobby.weaponMode = settings.weaponMode; changed = true;
          }
        }
        if (settings.killsToWin != null) {
          const kw = Number(settings.killsToWin);
          if (!ROUND_OPTIONS.includes(kw)) return cb?.({ error: 'bad_kills' });
          if (kw !== lobby.killsToWin) { lobby.killsToWin = kw; changed = true; }
        }
        if (settings.bet != null) {
          const b = Math.max(1, Math.floor(Number(settings.bet)));
          if (!Number.isFinite(b) || b <= 0) return cb?.({ error: 'bad_bet' });
          if (b !== lobby.bet) { lobby.bet = b; changed = true; }
        }
        if (changed) {
          unreadyNonHost(lobby);
          lobby.status = 'waiting';
        }
        cb?.({ ok: true });
        broadcastPrivateLobbyUpdate(io, lobby);
      } catch (e) { cb?.({ error: e.message || 'change_failed' }); }
    });

    // Host kicks a member.
    socket.on('kick_member', ({ userId } = {}, cb) => {
      const me = players.get(socket.id);
      if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
      const lobby = privateLobbies.get(me.privateLobby);
      if (!lobby) return cb?.({ error: 'no_lobby' });
      if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
      if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
      if (userId === me.userId) return cb?.({ error: 'cant_kick_self' });
      const idx = lobby.members.findIndex(m => m.userId === userId);
      if (idx < 0) return cb?.({ error: 'not_member' });
      const kicked = lobby.members[idx];
      lobby.members.splice(idx, 1);
      const kp = players.get(kicked.socketId);
      if (kp) kp.privateLobby = null;
      const ksock = io.of('/shooter').sockets.get(kicked.socketId);
      ksock?.leave('priv:' + lobby.id);
      ksock?.emit('kicked_from_lobby', { reason: 'host_kicked' });
      lobby.status = 'waiting';
      cb?.({ ok: true });
      broadcastPrivateLobbyUpdate(io, lobby);
    });

    // Host transfers leadership to another member.
    socket.on('transfer_host', ({ userId } = {}, cb) => {
      const me = players.get(socket.id);
      if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
      const lobby = privateLobbies.get(me.privateLobby);
      if (!lobby) return cb?.({ error: 'no_lobby' });
      if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
      if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
      const target = lobby.members.find(m => m.userId === userId);
      if (!target || target.userId === me.userId) return cb?.({ error: 'bad_target' });
      // The target must actually be connected — handing host to an
      // already-disconnected player would leave the lobby unleadable.
      if (!target.socketId || !players.has(target.socketId)) {
        return cb?.({ error: 'target_offline' });
      }
      lobby.hostUserId = target.userId;
      lobby.hostSocketId = target.socketId;
      // New host is implicitly ready; clear ready for the OLD host.
      const oldHost = lobby.members.find(m => m.userId === me.userId);
      if (oldHost) oldHost.ready = false;
      target.ready = true;
      lobby.status = 'waiting';
      cb?.({ ok: true });
      io.of('/shooter').to('priv:' + lobby.id).emit('host_transferred', {
        newHostUserId: target.userId, newHostUsername: target.username,
      });
      broadcastPrivateLobbyUpdate(io, lobby);
    });

    // Host fires Start. Final validation + balance recheck before escrow.
    socket.on('start_private_match', async (_, cb) => {
      try {
        const me = players.get(socket.id);
        if (!me?.privateLobby) return cb?.({ error: 'not_in_lobby' });
        const lobby = privateLobbies.get(me.privateLobby);
        if (!lobby) return cb?.({ error: 'no_lobby' });
        if (lobby.hostUserId !== me.userId) return cb?.({ error: 'not_host' });
        if (lobby.status !== 'waiting' && lobby.status !== 'ready') return cb?.({ error: 'already_started' });
        const need = lobby.teamSize * 2;
        if (lobby.members.length !== need) return cb?.({ error: 'lobby_not_full', need });

        const { balanced, allReady } = lobbyReadiness(lobby);
        if (!balanced) return cb?.({ error: 'teams_unbalanced' });
        if (!allReady) return cb?.({ error: 'not_all_ready' });

        // Verify every member is connected and has the bet on hand.
        for (const m of lobby.members) {
          if (!m.socketId || !players.has(m.socketId)) {
            return cb?.({ error: 'member_disconnected', userId: m.userId, username: m.username });
          }
          const bal = await getBalance(m.userId);
          if (bal < lobby.bet) {
            return cb?.({ error: 'member_broke', userId: m.userId, username: m.username });
          }
        }

        // All clear — mark starting and hand off to the existing engine.
        lobby.status = 'starting';
        broadcastPrivateLobbyUpdate(io, lobby);
        cb?.({ ok: true });
        try {
          await startPrivateMatch(io, lobby);
        } catch (e) {
          // Roll back the lobby state so the host can retry.
          console.error('[shooter] startPrivateMatch failed', e);
          lobby.status = 'waiting';
          unreadyNonHost(lobby);
          io.of('/shooter').to('priv:' + lobby.id).emit('match_error', { error: e.message || 'start_failed' });
          broadcastPrivateLobbyUpdate(io, lobby);
        }
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

      // CS buy freeze: pin the player to their spawn — no movement allowed.
      // (The client also locks input; this is the server-side safety net.)
      if (econFrozen(state)) {
        socket.emit('position_correction', { position: state.lastPosition });
        return;
      }

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
        // Carry the current weapon so a remote model that missed the
        // opponent_weapon_switch event (late join, packet loss) can still
        // correct itself from movement. Server-authoritative value.
        weapon: state.weapon || DEFAULT_WEAPON,
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
      // Economy mode: can't equip a weapon you haven't bought (fails open
      // if loadout is missing).
      if (econActive(match) && state.loadout && !state.loadout.has(weapon)) {
        return noteSuspicious(match, socket.id, 'switch_not_owned', { attempted: weapon });
      }

      const now = Date.now();
      if (now - (state.lastWeaponSwitchAt || 0) < WEAPON_SWITCH_COOLDOWN_MS) {
        return noteSuspicious(match, socket.id, 'switch_cooldown');
      }
      if (weapon === state.weapon) return;

      state.weapon = weapon;
      state.lastWeaponSwitchAt = now;
      // Tell every OTHER player in the match so their third-person model of
      // this player can swap to the matching weapon. The name was already
      // validated against WEAPONS + the lobby weaponMode above, so we're
      // not trusting a raw client string here. Works for both 1v1 and team
      // modes — just skip the switching socket.
      const wsPayload = { socketId: socket.id, weapon, team: state.team || null };
      for (const sid of match.playerIds) {
        if (sid !== socket.id) ns.to(sid).emit('opponent_weapon_switch', wsPayload);
      }
      Replay.log(match.id, 'weapon_switch', { s: socket.id, w: weapon });
    });

    // ── buy_weapon ─────────────────────────────────────────────────────
    // CS:GO buy menu. Spends the in-match virtual money (NOT real credits)
    // on a weapon, validated against price, funds, and the open buy window.
    socket.on('buy_weapon', ({ weapon } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.status !== 'active' || !econActive(match)) return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;

      const wKey = String(weapon || '');
      const price = ECON.PRICES[wKey];
      const reply = (ok, reason) => socket.emit('buy_result', {
        ok, reason: reason || null, weapon: wKey,
        money: state.money, loadout: [...(state.loadout || [])],
      });

      if (price === undefined || !WEAPONS[wKey]) return reply(false, 'invalid');
      if (price <= 0)                            return reply(false, 'free');     // knife/pistol already owned
      if (Date.now() > (state.buyUntil || 0))    return reply(false, 'closed');   // buy window expired
      if (state.loadout.has(wKey))               return reply(false, 'owned');
      if ((state.money || 0) < price)            return reply(false, 'funds');

      state.money -= price;
      state.loadout.add(wKey);
      // Top the weapon's magazine off so the buy is immediately usable.
      if (state.weapons[wKey]) {
        state.weapons[wKey].ammo = WEAPONS[wKey].mag;
        state.weapons[wKey].reloading = false;
        state.weapons[wKey].reloadStartedAt = 0;
      }
      Replay.log(match.id, 'weapon_buy', { s: socket.id, w: wKey, money: state.money });
      reply(true, null);
    });

    // ── shoot ─────────────────────────────────────────────────────────
    socket.on('shoot', ({ origin, direction, timestamp, directions } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.status !== 'active') return;
      const state = match.gameState[socket.id];
      if (!state || state.respawning) return;
      // CS buy freeze: can't fire while frozen at spawn.
      if (econFrozen(state)) return;

      const wKey = state.weapon || DEFAULT_WEAPON;
      const W = WEAPONS[wKey];
      const wState = state.weapons[wKey];
      if (!W || !wState) return;
      // Honour the lobby weapon-mode vote.
      if (match.weaponMode && match.weaponMode !== 'all' && wKey !== match.weaponMode) {
        return noteSuspicious(match, socket.id, 'weapon_disallowed', { mode: match.weaponMode, attempted: wKey });
      }
      // Economy mode: you can only fire a weapon you actually bought this
      // round (knife/pistol are always owned). Fails OPEN if loadout is
      // somehow missing so a bug can never make shooting impossible.
      if (econActive(match) && state.loadout && !state.loadout.has(wKey)) {
        return noteSuspicious(match, socket.id, 'weapon_not_owned', { attempted: wKey });
      }
      if (wState.reloading) {
        // The reload setTimeout may not have fired yet even though the reload
        // time has actually elapsed (timer drift / lag). Finish it now so a
        // legit post-reload shot isn't eaten + falsely flagged.
        if (Date.now() - (wState.reloadStartedAt || 0) >= W.reloadMs - 120) {
          wState.reloading = false;
          wState.ammo = W.mag;
        } else {
          return noteSuspicious(match, socket.id, 'shot_while_reloading');
        }
      }

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

      // Broadcast the shot to every other player in the match so they
      // can spatialise the gunshot SFX (distance attenuation + HRTF
      // panning) AND render a brief tracer line in the world.
      // Knife slashes have no audible signature at range and no muzzle
      // exit, so we skip melee.
      if (!W.melee && origin) {
        const shotPayload = {
          origin: { x: origin.x, y: origin.y, z: origin.z },
          // Direction is the *primary* shot ray — even for shotgun we
          // ship the single aim direction so the tracer points where
          // the player aimed. Per-pellet spread is purely visual.
          direction: direction ? { x: direction.x, y: direction.y, z: direction.z } : null,
          weapon: wKey,
          shooterId: socket.id,
        };
        for (const sid of match.playerIds) {
          if (sid !== socket.id) ns.to(sid).emit('remote_shot', shotPayload);
        }
      } else if (W.melee) {
        // Knife swings have no muzzle/audio signature, but enemies should
        // still SEE a slash. Purely cosmetic + additive — no gameplay
        // impact, and clients that ignore it just don't animate.
        for (const sid of match.playerIds) {
          if (sid !== socket.id) ns.to(sid).emit('remote_melee', { shooterId: socket.id });
        }
      }

      // Find every possible target: in team mode, only enemy team members;
      // in 1v1, the single other player. Respawning targets are skipped.
      // Shootable = not respawning AND not within the spawn-invuln window.
      const nowMs = Date.now();
      const isShootable = (st) => st && !st.respawning && (st.invulnUntil || 0) <= nowMs;
      const candidates = match.isTeamMatch
        ? match.playerIds.filter(id =>
            id !== socket.id &&
            isShootable(match.gameState[id]) &&
            match.gameState[id].team !== state.team)
        : (() => {
            const opp = match.playerIds.find(id => id !== socket.id);
            return (opp && isShootable(match.gameState[opp])) ? [opp] : [];
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

      // Boundary walls derived from the match's REAL arena size (cached
      // on the match). The old hard-coded ±20.25 walls only matched the
      // 40-unit maps; on the 70 m Depot they became invisible mid-field
      // walls that swallowed bullets.
      if (!match.wallAabbs) match.wallAabbs = arenaWalls(match.arenaSize || 40);
      const walls = match.wallAabbs;

      // For each candidate enemy, run all the rays and aggregate damage.
      // Pick the enemy with the closest hit (so a shot in a crowd hits
      // the one in front, not "every body it passes through").
      const rewindTs = timestamp ?? now;
      let bestTarget = null;
      let bestNearest = Infinity;
      let bestDmg = 0;
      let bestHead = false;
      let bestPen = false;          // true if the winning ray went through thin cover

      for (const cSock of candidates) {
        const cState = match.gameState[cSock];
        const cPos = positionAtTime(cState.positionHistory, rewindTs) || cState.position;
        const bodyB = playerBox(cPos);
        const headB = headBox(cPos);

        // Per-weapon max ray length — knife caps at ~2.2m so it can't
        // be used as a free hitscan. Guns use 80m.
        const MR = W.maxRange || 80;
        let dmgHere = 0, hitHere = false, headHere = false, nearestHere = Infinity;
        let penetratedHere = false;
        for (const ray of rays) {
          // Split cover into "blocking" (solid crates, walls) and
          // "penetrable" (thin railings, fence boards). Penetrable
          // cover doesn't stop the bullet — it just halves the damage.
          let coverDist = Infinity;     // closest BLOCKING cover
          let penDist   = Infinity;     // closest penetrable cover (for tagging)
          for (const c of match.coverAabbs) {
            const d = rayHitDistance(ray, c, MR);
            if (d === Infinity) continue;
            if (c.penetrable) { if (d < penDist)   penDist   = d; }
            else              { if (d < coverDist) coverDist = d; }
          }
          for (const w of walls) {
            // Arena walls are never penetrable.
            const d = rayHitDistance(ray, w, MR); if (d < coverDist) coverDist = d;
          }
          const headDist = rayHitDistance(ray, headB, MR);
          const bodyDist = rayHitDistance(ray, bodyB, MR);
          // Reject hits past the weapon's max reach.
          if (headDist > MR && bodyDist > MR) continue;
          // Did the ray go *through* any thin cover before reaching the
          // target? If so this pellet/shot is a wall-bang.
          const isPen = (penDist !== Infinity) &&
                        (penDist < Math.min(headDist, bodyDist));
          if (headDist < coverDist && headDist <= bodyDist) {
            const penMult = isPen ? COVER_PENETRATION_DAMAGE_MULT : 1;
            const distMult = damageMultiplier(W, headDist);
            dmgHere += Math.round(W.headDmg * penMult * distMult);
            hitHere = true; headHere = true;
            if (headDist < nearestHere) nearestHere = headDist;
            if (isPen) penetratedHere = true;
          } else if (bodyDist < coverDist && bodyDist !== Infinity) {
            const penMult = isPen ? COVER_PENETRATION_DAMAGE_MULT : 1;
            const distMult = damageMultiplier(W, bodyDist);
            dmgHere += Math.round(W.dmg * penMult * distMult);
            hitHere = true;
            if (bodyDist < nearestHere) nearestHere = bodyDist;
            if (isPen) penetratedHere = true;
          }
        }
        if (hitHere && nearestHere < bestNearest) {
          bestNearest = nearestHere;
          bestTarget  = cSock;
          bestDmg     = dmgHere;
          bestHead    = headHere;
          bestPen     = penetratedHere;
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
      socket.emit('hit_result', { hit: true, headshot: didHead, damage: totalDmg, penetrated: bestPen, ammo: wState.ammo, weapon: wKey });
      // Notify the victim. The single helper carries attackerPos so
      // future damage sources don't re-duplicate the payload shape.
      emitYouHit(ns, oppSock, state.position, {
        health: fatal ? 0 : oppState.health,
        headshot: didHead,
        fatal,
      });

      if (fatal) {
        state.kills++;
        state.streakKills = (state.streakKills || 0) + 1;
        oppState.deaths++;
        oppState.streakKills = 0;          // dying resets the killer's-side streak counter
        awardKillEconomy(io, match, socket.id, state, wKey);   // CS economy: kill reward

        // Real-time achievement grants. These are fire-and-forget — the
        // tryGrant helper resolves async and only emits if it was new.
        const killerUserId = players.get(socket.id)?.userId;
        if (killerUserId) {
          tryGrant(io, socket.id, killerUserId, Achievements.KEYS.FIRST_KILL);
          if (didHead)       tryGrant(io, socket.id, killerUserId, Achievements.KEYS.FIRST_HEADSHOT);
          if (bestPen)       tryGrant(io, socket.id, killerUserId, Achievements.KEYS.WALL_BANGER);
          if (wKey === 'knife') tryGrant(io, socket.id, killerUserId, Achievements.KEYS.COLD_STEEL);
          if (wKey === 'shotgun' && totalDmg >= MAX_HEALTH) {
            tryGrant(io, socket.id, killerUserId, Achievements.KEYS.ONE_PUMP);
          }
          if (state.streakKills === 3) tryGrant(io, socket.id, killerUserId, Achievements.KEYS.KILLING_SPREE);
          if (state.streakKills === 5) tryGrant(io, socket.id, killerUserId, Achievements.KEYS.RAMPAGE);
        }

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
        // Full scoreboard refresh — keeps the TAB scoreboard in sync
        // without each client having to track every kill_event field.
        emitScoreboard(io, match);

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
            // Refill throwables on respawn so molotov/smoke counts reset.
            refillThrowables(oppState);
            // CS economy: loss bonus + reset loadout + reopen the buy freeze.
            const freezeUntil = respawnEconomy(io, match, oppSock, oppState);
            // Invuln covers the buy freeze (economy) or the normal grace.
            const invulnUntil = freezeUntil ? freezeUntil + 500 : Date.now() + SPAWN_INVULN_MS;
            oppState.invulnUntil = invulnUntil;
            Replay.log(match.id, 'player_spawn', { s: oppSock, p: spawn });
            ns.to(oppSock).emit('respawn', { position: spawn, health: MAX_HEALTH, invulnUntil, freezeUntil });
            ns.to(socket.id).emit('opponent_respawn', { position: spawn, invulnUntil });
            emitInvulnStart(io, match, oppSock, invulnUntil);
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

    // ── Throwables ──────────────────────────────────────────────────
    socket.on('throwable_select', ({ type } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match) return;
      const state = match.gameState[socket.id];
      if (!state) return;
      if (!THROWABLE_TYPES.includes(type)) return;
      state.selectedThrowable = type;
    });

    socket.on('throwable_throw', ({ type, origin, direction, timestamp } = {}, cb) => {
      try {
        const p = players.get(socket.id);
        if (!p?.currentMatch) return cb?.({ error: 'no_match' });
        const match = matches.get(p.currentMatch);
        if (!match || match.status !== 'active') return cb?.({ error: 'no_match' });
        const state = match.gameState[socket.id];
        if (!state) return cb?.({ error: 'no_state' });
        if (state.respawning) return cb?.({ error: 'respawning' });
        if (econFrozen(state)) return cb?.({ error: 'frozen' });   // CS buy freeze

        const t = THROWABLE_TYPES.includes(type) ? type : state.selectedThrowable;
        if (!THROWABLE_TYPES.includes(t)) return cb?.({ error: 'bad_type' });
        const cfg = THROWABLE_CONFIG[t];

        // Cooldown.
        const now = Date.now();
        if (now - (state.lastThrowAt || 0) < cfg.cooldownMs) {
          return cb?.({ error: 'cooldown' });
        }
        // Ammo.
        if (!state.throwables[t] || state.throwables[t].count <= 0) {
          return cb?.({ error: 'out_of_throwable' });
        }
        // Origin / direction validation.
        if (!origin || !direction ||
            !Number.isFinite(origin.x)    || !Number.isFinite(origin.y)    || !Number.isFinite(origin.z) ||
            !Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z)) {
          return cb?.({ error: 'bad_origin' });
        }
        // Direction must roughly match the player's known yaw — same
        // forgiving threshold as shot-direction.
        if (state.rotation && typeof state.rotation.y === 'number') {
          const yaw = state.rotation.y;
          const lookX = -Math.sin(yaw), lookZ = -Math.cos(yaw);
          const ml = Math.hypot(direction.x, direction.z) || 1;
          const dot = (direction.x / ml) * lookX + (direction.z / ml) * lookZ;
          if (dot < MAX_SHOT_DIRECTION_DEVIATION) {
            noteSuspicious(match, socket.id, 'throwable_direction', { dot: +dot.toFixed(2) });
            // Allow it — yaw lag means strict reject would punish real players.
          }
        }
        // Timestamp drift.
        const ts = Number(timestamp) || now;
        if (Math.abs(ts - now) > MAX_CLIENT_TIME_DRIFT_MS) {
          noteSuspicious(match, socket.id, 'throwable_time_drift', { drift: ts - now });
        }

        // OK — consume one, set cooldown, spawn projectile.
        state.throwables[t].count--;
        state.lastThrowAt = now;

        const id = 'pr-' + Math.random().toString(36).slice(2, 10);
        // Normalize direction and scale by throw speed.
        const dl = Math.hypot(direction.x, direction.y, direction.z) || 1;
        const vx = (direction.x / dl) * cfg.throwSpeed;
        // Add a small upward arc.
        const vy = (direction.y / dl) * cfg.throwSpeed + 3.0;
        const vz = (direction.z / dl) * cfg.throwSpeed;
        const proj = {
          id, type: t,
          ownerSocketId: socket.id,
          ownerUserId: p.userId,
          ownerTeam: state.team || null,
          position: { x: origin.x, y: origin.y, z: origin.z },
          velocity: { x: vx, y: vy, z: vz },
          createdAt: now,
          expiresAt: now + cfg.maxFlightMs,
        };
        match.projectiles = match.projectiles || new Map();
        match.projectiles.set(id, proj);
        ensureThrowableTick(io, match);

        // Broadcast spawn to every player in the match.
        for (const sid of match.playerIds) {
          ns.to(sid).emit('throwable_projectile_spawned', {
            id, type: t,
            ownerSocketId: socket.id,
            position: proj.position, velocity: proj.velocity,
          });
        }
        Replay.log(match.id, 'throwable_throw', {
          s: socket.id, type: t,
        });
        // Echo the new count back so the HUD updates instantly.
        cb?.({ ok: true, count: state.throwables[t].count, type: t });
      } catch (e) {
        console.error('[shooter] throwable_throw failed', e);
        cb?.({ error: e.message || 'throw_failed' });
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
    // ── In-match chat (CS:GO style — all + team scope) ──────────────────
    // scope='all' broadcasts to every player in the match (default).
    // scope='team' restricts to teammates in a team match. In 1v1 the
    // team-scope falls back to all-chat (you have no teammate).
    socket.on('match_chat', ({ body, scope } = {}) => {
      const p = players.get(socket.id);
      if (!p?.currentMatch) return;
      const match = matches.get(p.currentMatch);
      if (!match || match.ended) return;
      const text = String(body || '').trim().slice(0, 200);
      if (!text) return;
      const wantTeam = scope === 'team' && match.isTeamMatch;
      const myTeam = match.gameState[socket.id]?.team || null;
      // Look up the sender's display name so the chat line matches the
      // killfeed style (display name first, fall back to username).
      const senderRow = { username: p.username };
      pool.query(
        'SELECT username, display_name FROM users WHERE id = $1',
        [p.userId]
      ).then(({ rows }) => {
        if (rows[0]) Object.assign(senderRow, rows[0]);
        const fromName = senderRow.display_name || senderRow.username || 'Player';
        const payload = {
          from: fromName,
          fromUsername: senderRow.username || null,
          body: text,
          scope: wantTeam ? 'team' : 'all',
          fromTeam: myTeam,
          isYou: false,
        };
        for (const sid of match.playerIds) {
          if (sid === socket.id) continue;
          if (wantTeam) {
            const otherTeam = match.gameState[sid]?.team || null;
            if (otherTeam !== myTeam) continue;
          }
          ns.to(sid).emit('match_chat', payload);
        }
      }).catch(() => {
        // Fallback: send with the username we already have.
        const payload = {
          from: p.username || 'Player', body: text,
          scope: wantTeam ? 'team' : 'all',
          fromTeam: myTeam, isYou: false,
        };
        for (const sid of match.playerIds) {
          if (sid === socket.id) continue;
          if (wantTeam && match.gameState[sid]?.team !== myTeam) continue;
          ns.to(sid).emit('match_chat', payload);
        }
      });
    });

    // ── Public matchmaking queue ────────────────────────────────────────
    // Replaces the old per-tier auto-pair lobby flow. mm_join puts the
    // socket in the (tier, teamSize) queue, forming or joining a team;
    // mm_leave pulls them out (and downgrades the team's status if it
    // was full or paired).
    socket.on('mm_join', ({ tier, teamSize } = {}, cb) => {
      const res = joinMm(io, socket, tier, teamSize);
      cb?.(res);
    });
    socket.on('mm_leave', (_, cb) => {
      removeFromMm(io, socket.id);
      cb?.({ ok: true });
    });

    // ── Voting in the MM waiting room ───────────────────────────────────
    // Each member casts one vote per category. Votes live on the team
    // until the match starts; on pairing, both teams' votes are merged
    // and the existing resolve* helpers pick the winner (random tiebreak).
    socket.on('mm_vote_map', ({ map } = {}) => {
      const team = teamOfSocket(socket.id);
      if (!team || !MAP_TYPES.includes(map)) return;
      team.mapVotes[socket.id] = map;
      broadcastMmTeam(io, team);
    });
    socket.on('mm_vote_mode', ({ mode } = {}) => {
      const team = teamOfSocket(socket.id);
      if (!team || !WEAPON_MODES.includes(mode)) return;
      team.modeVotes[socket.id] = mode;
      broadcastMmTeam(io, team);
    });
    socket.on('mm_vote_rounds', ({ rounds } = {}) => {
      const team = teamOfSocket(socket.id);
      if (!team) return;
      const n = Number(rounds);
      if (!ROUND_OPTIONS.includes(n)) return;
      team.roundsVotes[socket.id] = n;
      broadcastMmTeam(io, team);
    });

    // ── Friend invites (team modes only, sizes >= 2) ────────────────────
    socket.on('mm_invite_friend', async ({ friendUserId } = {}, cb) => {
      try {
        const team = teamOfSocket(socket.id);
        if (!team)               return cb?.({ error: 'not_in_team' });
        if (team.teamSize < 2)   return cb?.({ error: 'no_invites_in_1v1' });
        if (team.status !== 'forming') return cb?.({ error: 'team_full' });
        if (team.members.length >= team.teamSize) return cb?.({ error: 'team_full' });

        const me = players.get(socket.id);
        if (!me) return cb?.({ error: 'not_ready' });
        if (!(await areFriends(me.userId, friendUserId))) {
          return cb?.({ error: 'not_friends' });
        }
        if (team.pendingInvites.has(friendUserId)) return cb?.({ error: 'already_invited' });

        const targetSid = findShooterSocketByUserId(io, friendUserId);
        // If the friend IS on the shooter page, the existing path also
        // validates that they're not already in a match / queue. If
        // they're on another page (dashboard, leaderboard, …) we still
        // send the invite via the /chat namespace and let the shooter
        // page do the "already in something" check when they actually
        // try to accept.
        let chatOnly = false;
        if (targetSid) {
          const tp = players.get(targetSid);
          if (tp?.currentMatch)               return cb?.({ error: 'friend_in_match' });
          if (mmTeamBySocket.has(targetSid))  return cb?.({ error: 'friend_in_queue' });
        } else {
          chatOnly = true;
        }

        // Stash the invite + expire after 90 s. Slightly longer than
        // the original 60 s because cross-page accepts need time for
        // the friend to navigate to /shooter.
        const TTL_MS = 90_000;
        const timer = setTimeout(() => {
          team.pendingInvites.delete(friendUserId);
          if (targetSid) ns.to(targetSid).emit('mm_invite_expired', { teamId: team.id });
          io.of('/chat').to('u:' + friendUserId).emit('team_invite_expired', { teamId: team.id });
        }, TTL_MS);
        team.pendingInvites.set(friendUserId, { timer, fromSocketId: socket.id });

        const payload = {
          teamId: team.id,
          fromUserId:    me.userId,
          fromUsername:  me.username,
          tier: team.tier,
          teamSize: team.teamSize,
          bet: team.bet,
          filled: team.members.length,
          // The shooter URL the invitee should hit on Accept when they
          // aren't already on the shooter page.
          joinUrl: '/games/shooter.html?inv=' + encodeURIComponent(team.id),
        };
        // Deliver via /shooter when present, AND always via /chat so the
        // friend sees the toast no matter what page they're on. The
        // chat handler is what guarantees cross-page reach.
        if (targetSid) ns.to(targetSid).emit('mm_invite_received', payload);
        io.of('/chat').to('u:' + friendUserId).emit('team_invite_received', payload);
        cb?.({ ok: true, deliveredVia: chatOnly ? 'chat' : 'shooter+chat' });
      } catch (e) { cb?.({ error: e.message || 'invite_failed' }); }
    });

    socket.on('mm_invite_accept', ({ teamId } = {}, cb) => {
      const team = mmTeamById.get(teamId);
      if (!team) return cb?.({ error: 'team_gone' });
      const me = players.get(socket.id);
      if (!me) return cb?.({ error: 'not_ready' });
      const inv = team.pendingInvites.get(me.userId);
      if (!inv) return cb?.({ error: 'invite_not_found' });
      if (team.status !== 'forming' || team.members.length >= team.teamSize) {
        team.pendingInvites.delete(me.userId);
        clearTimeout(inv.timer);
        return cb?.({ error: 'team_full' });
      }
      if (mmTeamBySocket.has(socket.id) || me.currentMatch || me.currentLobby || me.privateLobby) {
        return cb?.({ error: 'already_in_something' });
      }
      // Slot directly into the team (skip queue lookup).
      clearTimeout(inv.timer);
      team.pendingInvites.delete(me.userId);
      team.members.push({ socketId: socket.id, userId: me.userId, username: me.username });
      mmTeamBySocket.set(socket.id, team.id);
      if (team.members.length >= team.teamSize) team.status = 'full';
      broadcastMmTeam(io, team);
      if (team.status === 'full') {
        const queue = getMmQueue(team.tier, team.teamSize);
        tryPairMm(io, queue);
      }
      cb?.({ ok: true, teamId: team.id, status: team.status,
             tier: team.tier, teamSize: team.teamSize, bet: team.bet });
    });

    socket.on('mm_invite_decline', ({ teamId } = {}) => {
      const team = mmTeamById.get(teamId);
      const me = players.get(socket.id);
      if (!team || !me) return;
      const inv = team.pendingInvites.get(me.userId);
      if (!inv) return;
      clearTimeout(inv.timer);
      team.pendingInvites.delete(me.userId);
      ns.to(inv.fromSocketId).emit('mm_invite_declined', {
        userId: me.userId, username: me.username,
      });
    });

    // ── Voice chat signaling (WebRTC P2P, teammates only) ──────────────
    // The server is purely a relay — never touches the audio itself. We
    // gate every message on "both players are in the same active match
    // AND on the same team". That keeps voice fanout to teammates only;
    // enemies and players in other matches never receive these.
    function voiceTeammateSid(meSockId, targetSockId) {
      if (!targetSockId || meSockId === targetSockId) return null;
      const me = players.get(meSockId);
      if (!me?.currentMatch) return null;
      const match = matches.get(me.currentMatch);
      if (!match || match.ended || !match.isTeamMatch) return null;
      if (!match.playerIds.includes(targetSockId)) return null;
      const myTeam  = match.gameState[meSockId]?.team;
      const tgtTeam = match.gameState[targetSockId]?.team;
      if (!myTeam || myTeam !== tgtTeam) return null;
      return targetSockId;
    }

    socket.on('voice_offer', ({ to, sdp } = {}) => {
      const tgt = voiceTeammateSid(socket.id, to);
      if (!tgt || !sdp) return;
      ns.to(tgt).emit('voice_offer', { from: socket.id, sdp });
    });
    socket.on('voice_answer', ({ to, sdp } = {}) => {
      const tgt = voiceTeammateSid(socket.id, to);
      if (!tgt || !sdp) return;
      ns.to(tgt).emit('voice_answer', { from: socket.id, sdp });
    });
    socket.on('voice_ice_candidate', ({ to, candidate } = {}) => {
      const tgt = voiceTeammateSid(socket.id, to);
      if (!tgt || !candidate) return;
      ns.to(tgt).emit('voice_ice_candidate', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      const p = players.get(socket.id);
      if (p?.currentMatch) Replay.log(p.currentMatch, 'disconnect', { s: socket.id });
      // Tell any current teammates the peer is gone so they can tear
      // down the RTCPeerConnection cleanly.
      if (p?.currentMatch) {
        const match = matches.get(p.currentMatch);
        if (match?.isTeamMatch) {
          const myTeam = match.gameState[socket.id]?.team;
          for (const sid of match.playerIds) {
            if (sid === socket.id) continue;
            if (match.gameState[sid]?.team === myTeam) {
              ns.to(sid).emit('voice_peer_left', { from: socket.id });
            }
          }
        }
      }
      handleLeave(socket, true);
    });
  });

  function handleLeave(socket, fromDisconnect = false) {
    const p = players.get(socket.id);
    if (!p) return;

    // If they were sitting in a public matchmaking team, drop them out.
    // (No reconnect grace for queue position — they can rejoin with one
    // click.)
    removeFromMm(io, socket.id);

    // Active match: disconnects get a reconnect grace window before
    // forfeit. Explicit leave (leave_match / leave_lobby etc) is still
    // an immediate forfeit. Track whether we parked the player so the
    // final players.delete() below doesn't strand the still-needed
    // record (endMatch resolves userIds via players.get()).
    let scheduledMatchGrace = false;
    if (p.currentMatch) {
      const match = matches.get(p.currentMatch);
      if (match && !match.ended) {
        if (fromDisconnect) {
          scheduleMatchLeave(io, p.userId, socket.id, match);
          scheduledMatchGrace = true;
        } else if (match.isTeamMatch) {
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
            endMatch(io, match.id, otherTeam, 'forfeit');
          }
        } else {
          const opp = match.playerIds.find(id => id !== socket.id);
          endMatch(io, match.id, opp, 'forfeit');
        }
      }
    }
    // If they were in a private lobby (pre-match), defer the leave on
    // disconnect so a tab refresh / network blip doesn't kill the
    // lobby. Explicit leave (button) goes through leave_private_lobby
    // and stays immediate.
    if (p.privateLobby) {
      if (fromDisconnect) scheduleLeavePrivate(io, p.userId, socket);
      else                handleLeavePrivate(socket);
    }

    // Public arena lobby. Disconnects get a reconnect-grace window so a
    // background-tab blip during the countdown doesn't strand both
    // players. Explicit leave (leave_lobby button) goes through
    // handleLeave with fromDisconnect=false → immediate.
    if (p.currentLobby) {
      if (fromDisconnect) {
        // Leave the player parked in the lobby — schedulePublicLobbyLeave
        // will drop them in RECONNECT_GRACE_MS unless they come back.
        schedulePublicLobbyLeave(io, p.userId);
        socket.leave(p.currentLobby);
        p.currentLobby = null;
      } else {
        const lobby = lobbies.get(p.currentLobby);
        if (lobby) {
          lobby.players = lobby.players.filter(id => id !== socket.id);
          delete lobby.mapVotes[socket.id];
          delete lobby.modeVotes[socket.id];
          delete lobby.roundsVotes[socket.id];
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
    }

    broadcastLobbies(io);
    // If we parked the player for match reconnect, KEEP their players
    // entry alive — endMatch (when grace expires) needs players.get(sid)
    // to resolve userIds for the wallet + ranking writes. The grace
    // timer's callback handles the final players.delete() itself.
    if (!scheduledMatchGrace) players.delete(socket.id);
  }
}

module.exports = { attach };
