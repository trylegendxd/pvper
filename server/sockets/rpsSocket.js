// server/sockets/rpsSocket.js — Best-of-3 RPS PvP over Socket.IO
const { pool } = require('../db');
const { getBalance } = require('../wallet');
const rps = require('../games/rps');

const ROUND_TIMEOUT_MS = 15000;
const ROUNDS_TO_WIN    = 2;     // best of 3

// In-memory live state
const queue   = new Map();   // betAmount → [socketId,...]   (waiting players)
const matches = new Map();   // matchId   → live match state
const sockets = new Map();   // socketId  → { userId, username, currentMatch }

function attach(io) {
  const ns = io.of('/rps');

  ns.use((socket, next) => {
    const userId = socket.request?.session?.userId;
    if (!userId) return next(new Error('not_authenticated'));
    socket.data.userId = userId;
    next();
  });

  ns.on('connection', async socket => {
    const userId = socket.data.userId;
    const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
    const username = rows[0]?.username || 'player';
    sockets.set(socket.id, { userId, username, currentMatch: null });

    socket.emit('rps_ready', {});

    socket.on('find_match', async ({ bet } = {}, cb) => {
      bet = Math.floor(Number(bet));
      if (!Number.isFinite(bet) || bet <= 0) return cb?.({ error: 'invalid_bet' });

      const meS = sockets.get(socket.id);
      if (meS.currentMatch) return cb?.({ error: 'already_in_match' });

      const bal = await getBalance(userId);
      if (bal < bet) return cb?.({ error: 'insufficient_balance' });

      // Match with another waiting player at same bet
      const waiting = queue.get(bet) || [];
      const partnerSockId = waiting.find(sid => {
        const s = sockets.get(sid);
        return s && s.userId !== userId;
      });

      if (!partnerSockId) {
        if (!waiting.includes(socket.id)) waiting.push(socket.id);
        queue.set(bet, waiting);
        return cb?.({ ok: true, waiting: true });
      }

      // Pair up
      queue.set(bet, waiting.filter(id => id !== partnerSockId));
      const partner = sockets.get(partnerSockId);
      if (!partner) return cb?.({ error: 'partner_gone' });

      // Re-check balances before debiting
      const [pb, mb] = await Promise.all([getBalance(partner.userId), getBalance(userId)]);
      if (pb < bet || mb < bet) {
        return cb?.({ error: 'partner_insufficient' });
      }

      let dbResult;
      try {
        dbResult = await rps.createMatch(userId, partner.userId, bet);
      } catch (e) {
        console.error('[rps] createMatch failed', e);
        return cb?.({ error: e.message });
      }

      const match = {
        id: dbResult.matchId,
        bet,
        playerA: { sockId: socket.id, userId, username },
        playerB: { sockId: partnerSockId, userId: partner.userId, username: partner.username },
        scores: { a: 0, b: 0 },
        roundNo: 0,
        choices: { a: null, b: null },
        roundTimer: null,
        finished: false,
      };
      matches.set(match.id, match);
      sockets.get(socket.id).currentMatch       = match.id;
      sockets.get(partnerSockId).currentMatch  = match.id;

      const playersPayload = {
        a: { username },
        b: { username: partner.username },
      };
      ns.to(socket.id).emit('match_found',      { matchId: match.id, you: 'a', players: playersPayload, bet });
      ns.to(partnerSockId).emit('match_found',  { matchId: match.id, you: 'b', players: playersPayload, bet });
      cb?.({ ok: true, matchId: match.id });

      startRound(io, match.id);
    });

    socket.on('cancel_find', () => {
      for (const [bet, arr] of queue.entries()) {
        const idx = arr.indexOf(socket.id);
        if (idx >= 0) { arr.splice(idx, 1); queue.set(bet, arr); }
      }
    });

    socket.on('choose', ({ matchId, choice } = {}) => {
      const match = matches.get(matchId);
      if (!match || match.finished) return;
      if (!rps.CHOICES.has(choice)) return;
      const meS = sockets.get(socket.id);
      if (!meS || meS.currentMatch !== matchId) return;

      const side = match.playerA.sockId === socket.id ? 'a'
                 : match.playerB.sockId === socket.id ? 'b' : null;
      if (!side) return;
      if (match.choices[side]) return; // locked

      match.choices[side] = choice;
      // Tell the other player their opponent has chosen (but not what)
      const otherSock = side === 'a' ? match.playerB.sockId : match.playerA.sockId;
      ns.to(otherSock).emit('opponent_chose');
      ns.to(socket.id).emit('your_choice_locked', { choice });

      if (match.choices.a && match.choices.b) {
        clearTimeout(match.roundTimer);
        resolveRound(io, match.id);
      }
    });

    socket.on('disconnect', () => handleLeave(socket));
  });

  function startRound(io, matchId) {
    const match = matches.get(matchId);
    if (!match || match.finished) return;
    match.roundNo += 1;
    match.choices  = { a: null, b: null };

    const payload = { round: match.roundNo, scores: match.scores, timeoutMs: ROUND_TIMEOUT_MS };
    ns.to(match.playerA.sockId).emit('round_start', payload);
    ns.to(match.playerB.sockId).emit('round_start', payload);

    match.roundTimer = setTimeout(() => resolveRound(io, matchId), ROUND_TIMEOUT_MS);
  }

  async function resolveRound(io, matchId) {
    const match = matches.get(matchId);
    if (!match || match.finished) return;
    const { a, b } = match.choices;
    if (!a && !b) {
      // Nobody played — cancel the whole match, refund
      try { await rps.cancelMatch(match.id, 'both_timeout'); } catch (e) {}
      match.finished = true;
      ns.to(match.playerA.sockId).emit('match_end', { result: 'cancelled', reason: 'both_timeout' });
      ns.to(match.playerB.sockId).emit('match_end', { result: 'cancelled', reason: 'both_timeout' });
      cleanup(match);
      return;
    }

    // If one side didn't play in time, other side wins the round
    let aChoice = a, bChoice = b;
    if (!a) aChoice = 'noplay';
    if (!b) bChoice = 'noplay';

    let roundWinner;
    if (!a && b)      roundWinner = 'b';
    else if (a && !b) roundWinner = 'a';
    else              roundWinner = rps.winnerOfRound(a, b);

    if (roundWinner === 'a') match.scores.a++;
    if (roundWinner === 'b') match.scores.b++;

    // Persist round
    try {
      await rps.recordRound(match.id, match.roundNo, aChoice === 'noplay' ? null : aChoice,
                                                     bChoice === 'noplay' ? null : bChoice);
    } catch (e) { console.error('[rps] recordRound', e); }

    const payload = {
      round: match.roundNo,
      choices: { a: aChoice, b: bChoice },
      roundWinner,
      scores: match.scores,
    };
    ns.to(match.playerA.sockId).emit('round_result', payload);
    ns.to(match.playerB.sockId).emit('round_result', payload);

    if (match.scores.a >= ROUNDS_TO_WIN || match.scores.b >= ROUNDS_TO_WIN || match.roundNo >= 3) {
      const winnerSide = match.scores.a > match.scores.b ? 'a'
                       : match.scores.b > match.scores.a ? 'b' : null;
      const winnerUser = winnerSide === 'a' ? match.playerA.userId
                      : winnerSide === 'b' ? match.playerB.userId : null;
      try {
        await rps.finishMatch(match.id, winnerUser, winnerSide ? 'best_of_3' : 'draw');
      } catch (e) { console.error('[rps] finishMatch', e); }

      const aBal = await getBalance(match.playerA.userId).catch(() => 0);
      const bBal = await getBalance(match.playerB.userId).catch(() => 0);
      ns.to(match.playerA.sockId).emit('match_end', {
        result: winnerSide === 'a' ? 'win' : winnerSide === 'b' ? 'lose' : 'draw',
        scores: match.scores, newBalance: aBal,
      });
      ns.to(match.playerB.sockId).emit('match_end', {
        result: winnerSide === 'b' ? 'win' : winnerSide === 'a' ? 'lose' : 'draw',
        scores: match.scores, newBalance: bBal,
      });
      match.finished = true;
      cleanup(match);
      return;
    }

    setTimeout(() => startRound(io, match.id), 1500);
  }

  function cleanup(match) {
    const a = sockets.get(match.playerA.sockId);
    const b = sockets.get(match.playerB.sockId);
    if (a) a.currentMatch = null;
    if (b) b.currentMatch = null;
    matches.delete(match.id);
  }

  async function handleLeave(socket) {
    const me = sockets.get(socket.id);
    if (!me) return;

    // Remove from queue
    for (const [bet, arr] of queue.entries()) {
      const i = arr.indexOf(socket.id);
      if (i >= 0) { arr.splice(i, 1); queue.set(bet, arr); }
    }

    // Forfeit in-progress match
    if (me.currentMatch) {
      const match = matches.get(me.currentMatch);
      if (match && !match.finished) {
        const winnerSide = match.playerA.sockId === socket.id ? 'b' : 'a';
        const winnerUser = winnerSide === 'a' ? match.playerA.userId : match.playerB.userId;
        try { await rps.finishMatch(match.id, winnerUser, 'opponent_disconnect'); } catch (e) {}
        const otherSock = winnerSide === 'a' ? match.playerA.sockId : match.playerB.sockId;
        const newBal = await getBalance(winnerUser).catch(() => 0);
        ns.to(otherSock).emit('match_end', { result: 'win', reason: 'opponent_disconnect', scores: match.scores, newBalance: newBal });
        match.finished = true;
        cleanup(match);
      }
    }
    sockets.delete(socket.id);
  }
}

module.exports = { attach };
