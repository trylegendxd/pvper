// public/js/rps.js — immersive RPS UI with hand-pump reveal animation
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const $ = id => document.getElementById(id);
  const HAND_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

  const lobbyView = $('lobby-view');
  const matchView = $('match-view');

  const socket = io('/rps', { withCredentials: true, transports: ['websocket','polling'] });

  // ── State ────────────────────────────────────────────────────────
  const S = {
    matchId: null,
    mySide:  null,   // 'a' | 'b'
    myChoiceLocked: false,
    bestOf: 3,
    scores: { a: 0, b: 0 },
    roundTimer: null,
  };

  // ── Helpers ──────────────────────────────────────────────────────
  function setStatus(t)      { $('lobby-status').textContent = t || ''; }
  function setRoundStatus(t) { $('round-status').textContent = t || ''; }

  function showVsIntro(youName, oppName, bet) {
    $('vs-you-name').textContent = youName.toUpperCase();
    $('vs-opp-name').textContent = oppName.toUpperCase();
    $('vs-bet').textContent = bet + ' cr';
    $('vs-intro').style.display = '';
    setTimeout(() => { $('vs-intro').style.display = 'none'; }, 1600);
  }

  function setPips(side, score) {
    const root = side === 'you' ? $('you-pips') : $('opp-pips');
    root.querySelectorAll('.pip').forEach((p, i) => {
      p.classList.toggle('lit', i < score);
    });
  }
  function refreshPipsForScores() {
    const youScore = S.mySide === 'a' ? S.scores.a : S.scores.b;
    const oppScore = S.mySide === 'a' ? S.scores.b : S.scores.a;
    setPips('you', youScore);
    setPips('opp', oppScore);
  }

  function setHandsToFist() {
    $('hand-you').textContent = '✊';
    $('hand-opp').textContent = '✊';
    ['hand-you','hand-opp'].forEach(id => {
      const el = $(id);
      el.classList.remove('revealed','pumping');
      el.classList.remove('loser-fade');
    });
    $('center-word').classList.remove('show','win','lose','tie');
    $('center-word').textContent = '';
    $('glow-left').classList.remove('show');
    $('glow-right').classList.remove('show');
  }

  function disableChoices(disabled) {
    document.querySelectorAll('.choice-btn').forEach(b => {
      b.disabled = !!disabled;
      if (disabled) b.classList.remove('selected');
    });
  }

  function pumpAndReveal(yourChoice, oppChoice, roundWinner) {
    // Reset and start the pump
    setHandsToFist();
    const youEl = $('hand-you');
    const oppEl = $('hand-opp');
    youEl.classList.add('pumping');
    oppEl.classList.add('pumping');

    // Mid-pump: announce the chant.
    setRoundStatus('ROCK!');
    setTimeout(() => setRoundStatus('PAPER!'),   430);
    setTimeout(() => setRoundStatus('SCISSORS!'), 860);

    // At ~1.5s (after 3 pumps) flip emoji to the real choice and pulse.
    setTimeout(() => {
      youEl.textContent = HAND_EMOJI[yourChoice] || '✊';
      oppEl.textContent = HAND_EMOJI[oppChoice]  || '✊';
      youEl.classList.remove('pumping');
      oppEl.classList.remove('pumping');
      youEl.classList.add('revealed');
      oppEl.classList.add('revealed');

      // Result word + glow
      const cw = $('center-word');
      cw.classList.add('show');
      if (!roundWinner) {
        cw.classList.add('tie');
        cw.textContent = 'TIE';
        setRoundStatus(`Tie · ${yourChoice} vs ${oppChoice}`);
      } else if (roundWinner === S.mySide) {
        cw.classList.add('win');
        cw.textContent = 'WIN';
        $('glow-left').classList.add('show');
        oppEl.classList.add('loser-fade');
        setRoundStatus(`You win the round · ${yourChoice} beats ${oppChoice}`);
      } else {
        cw.classList.add('lose');
        cw.textContent = 'LOSE';
        $('glow-right').classList.add('show');
        youEl.classList.add('loser-fade');
        setRoundStatus(`You lose the round · ${oppChoice} beats ${yourChoice}`);
      }
    }, 1500);
  }

  // ── Socket events ────────────────────────────────────────────────
  socket.on('connect',       () => setStatus('Connected — ready to find a match.'));
  socket.on('rps_ready',     () => setStatus('Connected — ready to find a match.'));
  socket.on('connect_error', err => {
    if (err.message === 'not_authenticated') {
      setStatus('Session expired — please log in again.');
      setTimeout(() => location.href = '/login.html', 1200);
      return;
    }
    setStatus('Connection error: ' + err.message);
  });

  socket.on('match_found', ({ matchId, you, players, bet }) => {
    S.matchId = matchId;
    S.mySide = you;
    S.scores = { a: 0, b: 0 };
    S.myChoiceLocked = false;
    const youName = you === 'a' ? players.a.username : players.b.username;
    const oppName = you === 'a' ? players.b.username : players.a.username;
    lobbyView.style.display = 'none';
    matchView.style.display = '';
    $('you-name').textContent = youName;
    $('opp-name').textContent = oppName;
    $('round-num').textContent = '1';
    refreshPipsForScores();
    setHandsToFist();
    disableChoices(true);
    setRoundStatus('Match starting…');
    showVsIntro(youName, oppName, bet);
  });

  socket.on('round_start', ({ round, scores, timeoutMs }) => {
    S.scores = scores || S.scores;
    S.myChoiceLocked = false;
    refreshPipsForScores();
    setHandsToFist();
    disableChoices(false);
    $('round-num').textContent = round;
    let s = Math.ceil(timeoutMs / 1000);
    const timerEl = $('round-timer');
    timerEl.textContent = s + 's';
    timerEl.classList.remove('warn');
    setRoundStatus('Choose!');
    clearInterval(S.roundTimer);
    S.roundTimer = setInterval(() => {
      s--;
      if (s < 0) { clearInterval(S.roundTimer); timerEl.textContent = ''; return; }
      timerEl.textContent = s + 's';
      timerEl.classList.toggle('warn', s <= 3);
    }, 1000);
  });

  socket.on('opponent_chose', () => {
    if (!S.myChoiceLocked) setRoundStatus('Opponent locked in — your turn!');
  });

  socket.on('your_choice_locked', ({ choice }) => {
    setRoundStatus(`You chose ${choice} — waiting for opponent…`);
  });

  socket.on('round_result', ({ round, choices, roundWinner, scores }) => {
    clearInterval(S.roundTimer);
    $('round-timer').textContent = '';
    $('round-timer').classList.remove('warn');
    S.scores = scores || S.scores;
    const yourC = S.mySide === 'a' ? choices.a : choices.b;
    const oppC  = S.mySide === 'a' ? choices.b : choices.a;
    pumpAndReveal(yourC, oppC, roundWinner);
    // Update pips after the reveal animation so they "count up" with the win.
    setTimeout(refreshPipsForScores, 1700);
  });

  socket.on('match_end', ({ result, scores, newBalance, reason }) => {
    clearInterval(S.roundTimer);
    if (scores) S.scores = scores;
    refreshPipsForScores();
    const banner = $('end-banner');
    const sub    = $('end-sub');
    if (result === 'win') {
      banner.textContent = 'VICTORY';
      banner.className = 'end-banner win';
      sub.textContent = newBalance != null ? `Balance: ${newBalance} cr` : '';
    } else if (result === 'lose') {
      banner.textContent = 'DEFEAT';
      banner.className = 'end-banner lose';
      sub.textContent = newBalance != null ? `Balance: ${newBalance} cr` : '';
    } else if (result === 'cancelled') {
      banner.textContent = 'CANCELLED';
      banner.className = 'end-banner draw';
      sub.textContent = reason ? `Reason: ${reason}` : '';
    } else {
      banner.textContent = 'DRAW';
      banner.className = 'end-banner draw';
      sub.textContent = '';
    }
    $('end-screen').style.display = '';
    disableChoices(true);
    if (typeof newBalance === 'number') {
      const bal = document.querySelector('.topbar .balance');
      if (bal) bal.textContent = fmtCredits(newBalance);
    }
  });

  // ── User actions ─────────────────────────────────────────────────
  $('find-btn').addEventListener('click', () => {
    const bet = Math.floor(Number($('bet').value));
    if (!bet || bet <= 0) { setStatus('Enter a positive bet.'); return; }
    $('find-btn').disabled = true;
    setStatus('Searching…');
    socket.emit('find_match', { bet }, (resp) => {
      if (resp?.error) {
        $('find-btn').disabled = false;
        setStatus(friendly(resp.error));
        return;
      }
      $('cancel-btn').style.display = '';
      setStatus(resp?.waiting ? 'Waiting for opponent…' : 'Match found!');
    });
  });
  $('cancel-btn').addEventListener('click', () => {
    socket.emit('cancel_find');
    $('cancel-btn').style.display = 'none';
    $('find-btn').disabled = false;
    setStatus('');
  });

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (S.myChoiceLocked) return;
      const c = btn.dataset.c;
      S.myChoiceLocked = true;
      btn.classList.add('selected');
      disableChoices(true);
      socket.emit('choose', { matchId: S.matchId, choice: c });
    });
  });

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
