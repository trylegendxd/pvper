// public/js/roulette.js — chip table + animated European wheel
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  // ── Constants ────────────────────────────────────────────────────────
  const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const colorOf = n => n === 0 ? 'green' : (RED.has(n) ? 'red' : 'black');
  const WHEEL_ORDER = [
    0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,
    10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26,
  ];
  const POCKETS = WHEEL_ORDER.length;          // 37
  const POCKET_ANGLE = 360 / POCKETS;          // 9.7297...

  // ── Build the wheel ──────────────────────────────────────────────────
  const wheel = document.getElementById('wheel');
  WHEEL_ORDER.forEach((n, i) => {
    const p = document.createElement('div');
    p.className = 'pocket ' + colorOf(n);
    p.style.transform = `rotate(${i * POCKET_ANGLE}deg)`;
    p.textContent = n;
    wheel.appendChild(p);
  });

  // ── Build the betting table ─────────────────────────────────────────
  // Layout (12 columns × 3 rows of numbers, plus 0 on the left and 2to1 column-bets on the right):
  //   row 1 (top):    3  6  9 12 15 18 21 24 27 30 33 36  2to1 (col 3)
  //   row 2 (mid):    2  5  8 11 14 17 20 23 26 29 32 35  2to1 (col 2)
  //   row 3 (bot):    1  4  7 10 13 16 19 22 25 28 31 34  2to1 (col 1)
  //   outside row:    [0?] [1-18] [EVEN] [RED] [BLACK] [ODD] [19-36]  +  [1st12] [2nd12] [3rd12]
  // Numbers above are placed visually as columns 1..12, but DB ordering 3->1 top->bottom is what casinos use.
  const felt = document.getElementById('felt');

  // We render in three "rows" with grid-row positioning
  // Build using HTML for simplicity
  const numbersHtml = (() => {
    let html = '';
    html += `<div class="zero" data-bet="straight" data-v="0">0</div>`;
    for (let row = 0; row < 3; row++) {
      // row 0 = top (3,6,..36), row 1 = mid, row 2 = bot
      // Column-major: col 1 → bottom row (1,4,7...), col 2 → mid, col 3 → top
      for (let col = 1; col <= 12; col++) {
        const num = (col - 1) * 3 + (3 - row);
        html += `<div class="cell ${colorOf(num)}" data-bet="straight" data-v="${num}">${num}</div>`;
      }
      html += `<div class="col-bet" data-bet="column" data-v="${3 - row}">2 to 1</div>`;
    }
    return html;
  })();

  felt.innerHTML = `
    <div class="row" style="grid-template-rows: 44px 44px 44px;">${numbersHtml}</div>
    <div class="outside-row">
      <div></div>
      <div class="outside" data-bet="dozen" data-v="1" style="grid-column: span 4">1st 12</div>
      <div class="outside" data-bet="dozen" data-v="2" style="grid-column: span 4">2nd 12</div>
      <div class="outside" data-bet="dozen" data-v="3" style="grid-column: span 4">3rd 12</div>
      <div></div>
    </div>
    <div class="outside-row">
      <div></div>
      <div class="outside" data-bet="low"   style="grid-column: span 2">1 to 18</div>
      <div class="outside" data-bet="even"  style="grid-column: span 2">EVEN</div>
      <div class="outside red"   data-bet="red"   style="grid-column: span 2">RED</div>
      <div class="outside black" data-bet="black" style="grid-column: span 2">BLACK</div>
      <div class="outside" data-bet="odd"   style="grid-column: span 2">ODD</div>
      <div class="outside" data-bet="high"  style="grid-column: span 2">19 to 36</div>
      <div></div>
    </div>
  `;

  // ── Bet state ────────────────────────────────────────────────────────
  let chipAmount = 1;
  const bets = new Map();   // key → { betType, betValue, amount, el }
  const history = [];       // stack of keys for undo

  function keyFor(betType, betValue) {
    return betValue == null ? betType : `${betType}:${betValue}`;
  }
  function chipColorFor(amt) {
    if (amt >= 500) return '#9b59b6';
    if (amt >= 100) return '#222';
    if (amt >= 25)  return '#2ecc71';
    if (amt >= 5)   return '#e63946';
    return '#ffffff';
  }
  function chipText(n) {
    if (n >= 1000) return Math.floor(n/1000) + 'k';
    return String(n);
  }

  function renderChipOn(el, amount) {
    let stack = el.querySelector('.chip-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'chip-stack';
      el.appendChild(stack);
    }
    stack.innerHTML = '';
    const c = document.createElement('div');
    c.className = 'chip';
    c.style.setProperty('--chip-color', chipColorFor(amount));
    if (chipColorFor(amount) === '#ffffff' || chipColorFor(amount) === '#222') c.style.color = chipColorFor(amount) === '#ffffff' ? '#000' : '#fff';
    c.textContent = chipText(amount);
    stack.appendChild(c);
  }
  function clearChipOn(el) {
    const s = el.querySelector('.chip-stack');
    if (s) s.remove();
  }
  function updateTotal() {
    let total = 0;
    for (const b of bets.values()) total += b.amount;
    document.getElementById('total-bet').textContent = total;
    document.getElementById('spin-btn').disabled = total === 0;
  }

  function placeBet(el) {
    const betType = el.dataset.bet;
    if (!betType) return;
    const betValue = el.dataset.v != null ? Number(el.dataset.v) : null;
    const key = keyFor(betType, betValue);
    const existing = bets.get(key);
    const amount = (existing?.amount || 0) + chipAmount;
    bets.set(key, { betType, betValue, amount, el });
    history.push(key);
    renderChipOn(el, amount);
    updateTotal();
  }

  function undo() {
    if (!history.length) return;
    const key = history.pop();
    const b = bets.get(key);
    if (!b) return;
    if (b.amount <= chipAmount) {
      bets.delete(key);
      clearChipOn(b.el);
    } else {
      b.amount -= chipAmount;
      renderChipOn(b.el, b.amount);
    }
    updateTotal();
  }
  function clearAll() {
    for (const b of bets.values()) clearChipOn(b.el);
    bets.clear();
    history.length = 0;
    updateTotal();
  }

  // Click anywhere with a data-bet attribute to place a chip
  felt.addEventListener('click', e => {
    let el = e.target;
    while (el && el !== felt && !el.dataset.bet) el = el.parentElement;
    if (el && el.dataset.bet) placeBet(el);
  });

  // Chip selector
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chipAmount = Number(btn.dataset.amt);
    });
  });
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('undo-btn').addEventListener('click', undo);

  // ── Spin ────────────────────────────────────────────────────────────
  let currentWheelRotation = 0;
  let currentBallRotation  = 0;
  let spinning = false;

  document.getElementById('spin-btn').addEventListener('click', async () => {
    if (spinning || bets.size === 0) return;
    spinning = true;
    document.getElementById('spin-btn').disabled = true;
    document.getElementById('banner').textContent = 'Spinning…';
    document.getElementById('banner').className = 'banner';

    const payload = {
      bets: Array.from(bets.values()).map(b => ({
        betType: b.betType, betValue: b.betValue, betAmount: b.amount,
      })),
    };

    try {
      const res = await api('/api/games/roulette/spin', { method: 'POST', body: payload });
      animateSpin(res);
    } catch (e) {
      spinning = false;
      document.getElementById('spin-btn').disabled = false;
      document.getElementById('banner').className = 'banner lose';
      document.getElementById('banner').textContent = friendly(e.message);
    }
  });

  function animateSpin({ number, color, payout, totalBet, balance, wheelIndex }) {
    // Target rotation: 5 full turns + land on winning pocket
    // The pocket at index i is rotated (i * angle). We want that pocket under the top pointer.
    // Wheel rotates clockwise → we need to ROTATE BY -(i*angle) modulo 360 (plus full spins)
    const landAngle = -(wheelIndex * (360 / 37));
    const extraTurns = 5;
    currentWheelRotation = currentWheelRotation - 360 * extraTurns;
    // snap to land angle keeping continuous rotation
    const desiredFinal = -(wheelIndex * (360 / 37));
    // recompute final so it lands precisely
    const totalRot = -360 * extraTurns - (wheelIndex * (360 / 37));
    wheel.style.transform = `rotate(${totalRot}deg)`;
    currentWheelRotation = totalRot;

    // Ball spins the OTHER way faster
    const ballTotal = 360 * (extraTurns + 3); // counter direction
    document.getElementById('ball').style.transform = `rotate(${ballTotal}deg)`;
    currentBallRotation = ballTotal;

    setTimeout(() => {
      // Result banner
      const banner = document.getElementById('banner');
      if (payout > totalBet)      { banner.className = 'banner win';  banner.textContent = `Number ${number} (${color}) · +${payout - totalBet} net (${payout} cr won)`; }
      else if (payout === totalBet) { banner.className = 'banner';      banner.textContent = `Number ${number} (${color}) · break-even`; }
      else if (payout > 0)        { banner.className = 'banner lose'; banner.textContent = `Number ${number} (${color}) · partial win ${payout}, net -${totalBet - payout}`; }
      else                        { banner.className = 'banner lose'; banner.textContent = `Number ${number} (${color}) · -${totalBet}`; }

      // Update top-bar balance
      const balEl = document.querySelector('.topbar .balance');
      if (balEl) balEl.textContent = fmtCredits(balance);

      // History list
      addHistory(number, color);
      // Clear bets for next round
      clearAll();
      spinning = false;
    }, 5100);
  }

  function addHistory(n, color) {
    const hist = document.getElementById('history');
    const tag = document.createElement('span');
    tag.style.background = color === 'red' ? '#c0142d' : color === 'black' ? '#161616' : '#128a3a';
    tag.textContent = n;
    hist.insertBefore(tag, hist.firstChild);
    while (hist.children.length > 18) hist.removeChild(hist.lastChild);
  }

  function friendly(c) {
    return ({
      insufficient_balance:'Not enough credits for that total bet.',
      invalid_bet_amount:'Enter a positive integer bet.',
      invalid_bet_type:'Unknown bet type.',
      invalid_bet_value:'Bad bet value.',
      no_bets:'Place a chip first.',
      too_many_bets:'Too many bets in one spin.',
    })[c] || c;
  }

  // Initial history load
  try {
    const { history: past } = await api('/api/games/roulette/history');
    past.reverse().forEach(h => addHistory(h.result_number, h.result_color));
  } catch (_) {}
})();
