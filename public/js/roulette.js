// public/js/roulette.js — canvas wheel + chip table + smooth spin animation
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  // ── Constants ────────────────────────────────────────────────────────────
  const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const colorOf = n => n === 0 ? 'green' : (RED.has(n) ? 'red' : 'black');
  const WHEEL_ORDER = [
    0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,
    10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26,
  ];
  const N            = WHEEL_ORDER.length;   // 37
  const POCKET_DEG   = 360 / N;              // ~9.7297°

  // ── Draw the wheel on a canvas (once, static) ─────────────────────────────
  function drawWheel(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const outerR  = W / 2 - 2;    // drawable radius
    const pocketR = outerR - 3;   // outer edge of pocket slices
    const innerR  = pocketR * 0.26; // inner edge of pockets (hub border)
    const numR    = pocketR * 0.73; // radius for number text

    const TAU = 2 * Math.PI;
    const arc = TAU / N;
    const S   = -Math.PI / 2; // 12 o'clock start

    // ── Background disc ──────────────────────────────────────────────────
    const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
    bgGrad.addColorStop(0,   '#2a1a0a');
    bgGrad.addColorStop(0.7, '#1a1008');
    bgGrad.addColorStop(1,   '#0e0805');
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, TAU);
    ctx.fillStyle = bgGrad;
    ctx.fill();

    // ── Pocket slices ────────────────────────────────────────────────────
    const POCKET_FILL  = { red: '#c41828', black: '#1c1c20', green: '#167530' };
    const POCKET_LIGHT = { red: '#e02038', black: '#2c2c30', green: '#1da040' };

    for (let i = 0; i < N; i++) {
      const num  = WHEEL_ORDER[i];
      const col  = colorOf(num);
      const a1   = S + i * arc;
      const a2   = a1 + arc;
      const midA = a1 + arc / 2;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a1) * innerR, cy + Math.sin(a1) * innerR);
      ctx.arc(cx, cy, pocketR, a1, a2);
      ctx.arc(cx, cy, innerR,  a2, a1, true);
      ctx.closePath();

      // Radial gradient (lighter near centre, darker near rim)
      const x1 = cx + Math.cos(midA) * innerR;
      const y1 = cy + Math.sin(midA) * innerR;
      const x2 = cx + Math.cos(midA) * pocketR;
      const y2 = cy + Math.sin(midA) * pocketR;
      const g   = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0,   POCKET_LIGHT[col]);
      g.addColorStop(1,   POCKET_FILL[col]);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // ── Separator lines (thin gold) ──────────────────────────────────────
    ctx.lineWidth   = 0.8;
    ctx.strokeStyle = 'rgba(190,130,30,0.55)';
    for (let i = 0; i < N; i++) {
      const a = S + i * arc;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
      ctx.lineTo(cx + Math.cos(a) * pocketR, cy + Math.sin(a) * pocketR);
      ctx.stroke();
    }

    // ── Outer ring circle ────────────────────────────────────────────────
    ctx.lineWidth   = 2.5;
    ctx.strokeStyle = '#b07828';
    ctx.beginPath(); ctx.arc(cx, cy, pocketR, 0, TAU); ctx.stroke();

    // ── Diamond separators on outer edge ────────────────────────────────
    for (let i = 0; i < N; i++) {
      const a  = S + i * arc;
      const dr = pocketR - 8;
      const px = cx + Math.cos(a) * dr;
      const py = cy + Math.sin(a) * dr;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(a + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -3.8);
      ctx.lineTo(2.6, 0);
      ctx.lineTo(0,  3.8);
      ctx.lineTo(-2.6, 0);
      ctx.closePath();
      ctx.fillStyle   = '#d4a030';
      ctx.strokeStyle = '#8a5010';
      ctx.lineWidth   = 0.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // ── Number labels ────────────────────────────────────────────────────
    const fontSize = Math.round(pocketR * 0.108);
    for (let i = 0; i < N; i++) {
      const num  = WHEEL_ORDER[i];
      const midA = S + (i + 0.5) * arc;
      const px   = cx + Math.cos(midA) * numR;
      const py   = cy + Math.sin(midA) * numR;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(midA + Math.PI / 2);
      ctx.fillStyle      = '#ffffff';
      ctx.font           = `700 ${fontSize}px Rajdhani, Arial, sans-serif`;
      ctx.textAlign      = 'center';
      ctx.textBaseline   = 'middle';
      ctx.shadowColor    = 'rgba(0,0,0,.9)';
      ctx.shadowBlur     = 3;
      ctx.fillText(num, 0, 0);
      ctx.restore();
    }

    // ── Inner ring (hub border) ──────────────────────────────────────────
    ctx.lineWidth   = 2;
    ctx.strokeStyle = '#b07828';
    ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, TAU); ctx.stroke();

    // ── Hub (centre boss) ────────────────────────────────────────────────
    const hubR    = innerR - 2;
    const hubGrad = ctx.createRadialGradient(cx - hubR * 0.28, cy - hubR * 0.28, hubR * 0.04, cx, cy, hubR);
    hubGrad.addColorStop(0,   '#e8c060');
    hubGrad.addColorStop(0.35,'#9a5c18');
    hubGrad.addColorStop(1,   '#3a1800');
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, TAU);
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.lineWidth   = 2;
    ctx.strokeStyle = '#c09030';
    ctx.stroke();

    // Hub spokes + rivets
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * hubR * 0.18, cy + Math.sin(a) * hubR * 0.18);
      ctx.lineTo(cx + Math.cos(a) * hubR * 0.80, cy + Math.sin(a) * hubR * 0.80);
      ctx.lineWidth   = 1.5;
      ctx.strokeStyle = '#a07820';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * hubR * 0.80, cy + Math.sin(a) * hubR * 0.80, 2.8, 0, TAU);
      ctx.fillStyle = '#d4b040';
      ctx.fill();
    }

    // Hub centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, hubR * 0.18, 0, TAU);
    ctx.fillStyle = '#e8c060';
    ctx.fill();
    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = '#8a5010';
    ctx.stroke();
  }

  // Build and draw the canvas wheel
  const wheelCanvas = document.getElementById('wheel');
  drawWheel(wheelCanvas);

  // ── Build the betting table ────────────────────────────────────────────
  const felt = document.getElementById('felt');
  const numbersHtml = (() => {
    let html = '';
    html += `<div class="zero" data-bet="straight" data-v="0">0</div>`;
    for (let row = 0; row < 3; row++) {
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

  // ── Bet state ─────────────────────────────────────────────────────────────
  let chipAmount = 1;
  const bets    = new Map();
  const history = [];

  const keyFor       = (t, v) => v == null ? t : `${t}:${v}`;
  const chipColorFor = (amt) => {
    if (amt >= 500) return '#9b59b6';
    if (amt >= 100) return '#222';
    if (amt >= 25)  return '#2ecc71';
    if (amt >= 5)   return '#e63946';
    return '#ffffff';
  };
  const chipText = n => n >= 1000 ? Math.floor(n/1000) + 'k' : String(n);

  function renderChipOn(el, amount) {
    let stack = el.querySelector('.chip-stack');
    if (!stack) { stack = document.createElement('div'); stack.className = 'chip-stack'; el.appendChild(stack); }
    stack.innerHTML = '';
    const c = document.createElement('div');
    c.className = 'chip';
    const cc = chipColorFor(amount);
    c.style.setProperty('--chip-color', cc);
    if (cc === '#ffffff' || cc === '#222') c.style.color = cc === '#ffffff' ? '#000' : '#fff';
    c.textContent = chipText(amount);
    stack.appendChild(c);
  }
  function clearChipOn(el) { const s = el.querySelector('.chip-stack'); if (s) s.remove(); }

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
    const b   = bets.get(key);
    if (!b) return;
    if (b.amount <= chipAmount) { bets.delete(key); clearChipOn(b.el); }
    else { b.amount -= chipAmount; renderChipOn(b.el, b.amount); }
    updateTotal();
  }

  function clearAll() {
    for (const b of bets.values()) clearChipOn(b.el);
    bets.clear(); history.length = 0; updateTotal();
  }

  felt.addEventListener('click', e => {
    let el = e.target;
    while (el && el !== felt && !el.dataset.bet) el = el.parentElement;
    if (el && el.dataset.bet) placeBet(el);
  });

  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chipAmount = Number(btn.dataset.amt);
    });
  });
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('undo-btn').addEventListener('click', undo);

  // ── Spin animation (cumulative rotation, no jump on repeat spins) ─────────
  let currentWheelRotation = 0;
  let currentBallRotation  = 0;
  let spinning = false;

  const wheelEl = document.getElementById('wheel');
  const ballEl  = document.getElementById('ball');

  // Ease: slow deceleration for a satisfying stop
  const WHEEL_EASE = 'cubic-bezier(0.10, 0.82, 0.18, 1.00)';
  const BALL_EASE  = 'cubic-bezier(0.18, 0.72, 0.18, 1.00)';
  const SPIN_MS    = 5500;

  function applyRotation(el, deg, ease) {
    el.style.transition = 'none';
    void el.offsetWidth; // force reflow so transition fires
    el.style.transition = `transform ${SPIN_MS}ms ${ease}`;
    el.style.transform  = `rotate(${deg}deg)`;
  }

  document.getElementById('spin-btn').addEventListener('click', async () => {
    if (spinning || bets.size === 0) return;
    spinning = true;
    document.getElementById('spin-btn').disabled = true;
    document.getElementById('banner').textContent = 'Spinning…';
    document.getElementById('banner').className   = 'banner';

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
      document.getElementById('banner').className  = 'banner lose';
      document.getElementById('banner').textContent = friendly(e.message);
    }
  });

  function animateSpin({ number, color, payout, totalBet, balance, wheelIndex }) {
    // --- Wheel rotation ---
    // Pocket i starts at (i * POCKET_DEG) degrees CW from 12 o'clock on the canvas.
    // CSS rotate(R) rotates element CW by R degrees.
    // For CCW spin: R is negative.
    // After rotate(R), pocket i appears at (i * POCKET_DEG + R) degrees from 12 o'clock.
    // To bring pocket wheelIndex to 12 o'clock: wheelIndex * POCKET_DEG + R ≡ 0 (mod 360)
    // → R ≡ -(wheelIndex * POCKET_DEG) (mod 360)
    const targetDeg = -(wheelIndex * POCKET_DEG);
    const T_mod     = ((targetDeg % 360) + 360) % 360;
    const R_mod     = ((currentWheelRotation % 360) + 360) % 360;
    let   delta     = T_mod - R_mod;
    if (delta >= 0) delta -= 360;          // always spin CCW (negative direction)
    const finalWheel = currentWheelRotation + delta - 5 * 360;  // 5 extra CCW full spins
    applyRotation(wheelEl, finalWheel, WHEEL_EASE);
    currentWheelRotation = finalWheel;

    // --- Ball rotation ---
    // Ball spins CW (positive) while wheel spins CCW.
    // We want ball to end at 12 o'clock (top of track = 0° position) so it visually
    // sits on the winning number (which wheel brought to 12 o'clock).
    const ballSpins  = 8;
    const ballFinal  = Math.ceil((currentBallRotation + ballSpins * 360) / 360) * 360;
    applyRotation(ballEl, ballFinal, BALL_EASE);
    currentBallRotation = ballFinal;

    setTimeout(() => {
      const banner = document.getElementById('banner');
      if (payout > totalBet) {
        banner.className   = 'banner win';
        banner.textContent = `${number} (${color}) · +${payout - totalBet} cr net`;
      } else if (payout === totalBet) {
        banner.className   = 'banner';
        banner.textContent = `${number} (${color}) · break-even`;
      } else if (payout > 0) {
        banner.className   = 'banner lose';
        banner.textContent = `${number} (${color}) · partial win ${payout} cr, net -${totalBet - payout}`;
      } else {
        banner.className   = 'banner lose';
        banner.textContent = `${number} (${color}) · -${totalBet} cr`;
      }

      const balEl = document.querySelector('.topbar .balance');
      if (balEl) balEl.textContent = fmtCredits(balance);

      addHistory(number, color);
      clearAll();
      spinning = false;
    }, SPIN_MS + 200);
  }

  function addHistory(n, color) {
    const hist = document.getElementById('history');
    const tag  = document.createElement('span');
    tag.style.background = color === 'red' ? '#c0142d' : color === 'black' ? '#161616' : '#128a3a';
    tag.textContent = n;
    hist.insertBefore(tag, hist.firstChild);
    while (hist.children.length > 18) hist.removeChild(hist.lastChild);
  }

  function friendly(c) {
    return ({
      insufficient_balance: 'Not enough credits for that total bet.',
      invalid_bet_amount:   'Enter a positive integer bet.',
      invalid_bet_type:     'Unknown bet type.',
      invalid_bet_value:    'Bad bet value.',
      no_bets:              'Place a chip first.',
      too_many_bets:        'Too many bets in one spin.',
    })[c] || c;
  }

  try {
    const { history: past } = await api('/api/games/roulette/history');
    past.reverse().forEach(h => addHistory(h.result_number, h.result_color));
  } catch (_) {}
})();
