// public/js/rps.js
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const $ = id => document.getElementById(id);
  const lobbyView = $('lobby-view');
  const matchView = $('match-view');

  const socket = io('/rps', { withCredentials: true, transports: ['websocket','polling'] });
  let myMatchId = null, mySide = null, myChoiceLocked = false;

  socket.on('connect', () => {
    $('lobby-status').textContent = 'Connected — ready to find a match.';
  });
  socket.on('connect_error', err => {
    const msg = err.message === 'not_authenticated'
      ? 'Session expired — please log in again.'
      : 'Connection error: ' + err.message;
    $('lobby-status').textContent = msg;
    if (err.message === 'not_authenticated') {
      setTimeout(() => location.href = '/login.html', 1500);
    }
  });
  socket.on('rps_ready', () => {
    $('lobby-status').textContent = 'Connected — ready to find a match.';
  });

  $('find-btn').addEventListener('click', () => {
    const bet = Math.floor(Number($('bet').value));
    if (!bet || bet <= 0) { $('lobby-status').textContent = 'Enter a positive bet.'; return; }
    $('find-btn').disabled = true;
    $('lobby-status').textContent = 'Searching…';
    socket.emit('find_match', { bet }, (resp) => {
      if (resp.error) {
        $('find-btn').disabled = false;
        $('lobby-status').textContent = friendly(resp.error);
        return;
      }
      $('cancel-btn').style.display = '';
      $('lobby-status').textContent = resp.waiting ? 'Waiting for opponent…' : 'Match found!';
    });
  });

  $('cancel-btn').addEventListener('click', () => {
    socket.emit('cancel_find');
    $('cancel-btn').style.display = 'none';
    $('find-btn').disabled = false;
    $('lobby-status').textContent = '';
  });

  socket.on('match_found', ({ matchId, you, players, bet }) => {
    myMatchId = matchId; mySide = you;
    lobbyView.style.display = 'none';
    matchView.style.display = '';
    $('you-name').textContent = you === 'a' ? players.a.username : players.b.username;
    $('opp-name').textContent = you === 'a' ? players.b.username : players.a.username;
    $('you-score').textContent = '0';
    $('opp-score').textContent = '0';
    $('round-status').innerHTML = `Match started · bet <b>${bet} cr</b>`;
  });

  socket.on('round_start', ({ round, scores, timeoutMs }) => {
    myChoiceLocked = false;
    document.querySelectorAll('.choice-btn').forEach(b => { b.disabled = false; b.classList.remove('selected'); });
    setScores(scores);
    let s = Math.floor(timeoutMs / 1000);
    $('round-status').innerHTML = `Round <b>${round}</b> — choose! <span class="countdown">${s}s</span>`;
    clearInterval(window._tickTimer);
    window._tickTimer = setInterval(() => {
      s--; if (s < 0) return clearInterval(window._tickTimer);
      $('round-status').innerHTML = `Round <b>${round}</b> — choose! <span class="countdown">${s}s</span>`;
    }, 1000);
  });

  socket.on('opponent_chose', () => {
    if (!myChoiceLocked) {
      $('round-status').textContent = 'Opponent has chosen. Your turn!';
    }
  });

  socket.on('your_choice_locked', ({ choice }) => {
    $('round-status').textContent = `You chose ${choice}. Waiting for opponent…`;
  });

  socket.on('round_result', ({ round, choices, roundWinner, scores }) => {
    clearInterval(window._tickTimer);
    setScores(scores);
    const yourC = mySide === 'a' ? choices.a : choices.b;
    const oppC  = mySide === 'a' ? choices.b : choices.a;
    let txt;
    if (!roundWinner)                      txt = `Tie! You: ${yourC} · Opp: ${oppC}`;
    else if (roundWinner === mySide)       txt = `You win the round! ${yourC} beats ${oppC}`;
    else                                   txt = `You lose the round. ${oppC} beats ${yourC}`;
    $('round-status').textContent = txt;
  });

  socket.on('match_end', ({ result, scores, newBalance, reason }) => {
    setScores(scores || { a:0, b:0 });
    const banner = $('result-banner');
    if (result === 'win') { banner.textContent = 'VICTORY'; banner.className = 'result-banner win'; }
    else if (result === 'lose') { banner.textContent = 'DEFEAT'; banner.className = 'result-banner lose'; }
    else if (result === 'cancelled') { banner.textContent = 'CANCELLED'; banner.className = 'result-banner draw'; }
    else { banner.textContent = 'DRAW'; banner.className = 'result-banner draw'; }
    $('result').style.display = '';
    document.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
    if (typeof newBalance === 'number') {
      const bal = document.querySelector('.topbar .balance');
      if (bal) bal.textContent = fmtCredits(newBalance);
    }
    if (reason) $('round-status').textContent = 'Reason: ' + reason;
  });

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (myChoiceLocked) return;
      myChoiceLocked = true;
      document.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
      btn.classList.add('selected');
      socket.emit('choose', { matchId: myMatchId, choice: btn.dataset.c });
    });
  });

  function setScores(s) {
    if (mySide === 'a') { $('you-score').textContent = s.a; $('opp-score').textContent = s.b; }
    else                { $('you-score').textContent = s.b; $('opp-score').textContent = s.a; }
  }

  function friendly(code) {
    return ({
      insufficient_balance: 'Not enough credits for that bet.',
      invalid_bet: 'Enter a positive integer bet.',
      already_in_match: 'You are already in a match.',
      partner_insufficient: 'Opponent dropped — try again.',
      not_authenticated: 'Please log in again.',
    })[code] || code;
  }
})();
