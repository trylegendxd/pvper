// public/js/roulette.js
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const $ = id => document.getElementById(id);

  // Build number grid
  const grid = $('num-grid');
  for (let n = 0; n <= 36; n++) {
    const el = document.createElement('div');
    el.className = 'nb ' + (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
    el.textContent = n;
    el.dataset.n = n;
    el.addEventListener('click', () => {
      grid.querySelectorAll('.nb.active').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      $('spin-number').disabled = false;
      $('spin-number').textContent = `SPIN ${n} (36×)`;
    });
    grid.appendChild(el);
  }

  let spinning = false;
  async function spin(betType, betValue) {
    if (spinning) return;
    spinning = true;
    $('status').textContent = 'Spinning…';
    document.querySelectorAll('button[data-bet], #spin-number').forEach(b => b.disabled = true);
    const wheel = $('wheel');
    wheel.style.transform = `rotate(${Math.random() * 720 + 360}deg)`;
    try {
      const amt = Math.floor(Number($('amt').value));
      const { number, color, payout, balance } = await api('/api/games/roulette/spin', {
        method: 'POST', body: { betType, betValue, betAmount: amt },
      });
      setTimeout(() => {
        const rn = $('result-num');
        rn.textContent = number;
        rn.className = 'num ' + color;
        $('status').innerHTML = payout > 0
          ? `<span style="color:var(--green)">You won ${payout} cr!</span>`
          : `<span style="color:var(--red)">No payout this spin.</span>`;
        const bal = document.querySelector('.topbar .balance');
        if (bal) bal.textContent = fmtCredits(balance);
        // History
        const hist = $('history');
        const tag = document.createElement('span');
        tag.className = color === 'red' ? '' : color === 'black' ? '' : '';
        tag.style.background = color === 'red' ? '#7a1f25' : color === 'black' ? '#1b1b1b' : '#194a30';
        tag.textContent = number;
        hist.insertBefore(tag, hist.firstChild);
        while (hist.children.length > 18) hist.removeChild(hist.lastChild);
        spinning = false;
        document.querySelectorAll('button[data-bet]').forEach(b => b.disabled = false);
        if (grid.querySelector('.nb.active')) $('spin-number').disabled = false;
      }, 2200);
    } catch (e) {
      $('status').innerHTML = `<span style="color:var(--red)">${friendly(e.message)}</span>`;
      spinning = false;
      document.querySelectorAll('button[data-bet]').forEach(b => b.disabled = false);
      $('spin-number').disabled = !grid.querySelector('.nb.active');
    }
  }

  document.querySelectorAll('button[data-bet]').forEach(b => {
    b.addEventListener('click', () => spin(b.dataset.bet));
  });
  $('spin-number').addEventListener('click', () => {
    const sel = grid.querySelector('.nb.active');
    if (sel) spin('number', Number(sel.dataset.n));
  });

  function friendly(code) {
    return ({
      insufficient_balance: 'Not enough credits.',
      invalid_bet_amount:   'Enter a positive integer bet.',
      invalid_bet_type:     'Pick a valid bet.',
      invalid_bet_value:    'Pick a number 0–36.',
      not_authenticated:    'Session expired — log in again.',
    })[code] || code;
  }

  // Load past spins
  try {
    const { history } = await api('/api/games/roulette/history');
    const hist = $('history');
    history.reverse().forEach(h => {
      const tag = document.createElement('span');
      tag.style.background = h.result_color === 'red' ? '#7a1f25' : h.result_color === 'black' ? '#1b1b1b' : '#194a30';
      tag.textContent = h.result_number;
      hist.insertBefore(tag, hist.firstChild);
    });
  } catch (_) {}
})();
