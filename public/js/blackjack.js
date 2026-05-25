// public/js/blackjack.js — multi-hand blackjack with chip-stack betting
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const MAX_SEATS = 3;
  const CHIPS     = [5, 25, 100, 500, 1000];
  const MIN_BET   = 5;

  const $ = id => document.getElementById(id);

  const State = {
    // Setup phase: per-seat bet stacks.
    setupSeats: [0],     // each element = current bet for that seat
    selectedSeat: 0,     // which seat new chips go to
    // Play phase: array of hands returned by the server.
    hands: [],
  };

  // ── Card rendering ──────────────────────────────────────────────────
  function renderCard(c) {
    if (c.hidden) return `<div class="card-face hidden"></div>`;
    const red = (c.s === '♥' || c.s === '♦');
    return `<div class="card-face ${red ? 'red' : ''}">
      <span>${c.r}${c.s}</span>
      <span class="bot">${c.r}${c.s}</span>
    </div>`;
  }

  // ── Setup view (no hands dealt) ─────────────────────────────────────
  function renderSetup() {
    $('dealer-cards').innerHTML = '';
    $('dealer-val').textContent = '';
    $('seats-row').innerHTML = '';
    $('seats-row').style.setProperty('--seat-count', 1);

    const total = State.setupSeats.reduce((a, b) => a + b, 0);
    const canDeal = State.setupSeats.length > 0 && State.setupSeats.every(b => b >= MIN_BET);

    const seatRowsHtml = State.setupSeats.map((bet, i) => `
      <div class="seat-setup-row ${i === State.selectedSeat ? 'is-selected' : ''}" data-seat="${i}">
        <span class="ss-label">SEAT ${i + 1}</span>
        <span class="ss-bet">${bet} cr</span>
        ${State.setupSeats.length > 1 ? `<button class="ss-rm" data-rm="${i}">remove</button>` : '<span></span>'}
      </div>
    `).join('');

    $('setup-area').innerHTML = `
      <div class="setup-panel">
        <div class="seats-list">${seatRowsHtml}</div>
        <div class="total-bet">Total bet: <b>${total} cr</b> across ${State.setupSeats.length} ${State.setupSeats.length === 1 ? 'hand' : 'hands'}</div>
        <div class="chip-rack" id="chip-rack">
          ${CHIPS.map(v => `<button class="chip c-${v}" data-chip="${v}" title="Add ${v}">${v}</button>`).join('')}
          <button class="chip chip-clear" data-clear="1" title="Clear selected seat">×</button>
        </div>
        <div class="setup-actions">
          ${State.setupSeats.length < MAX_SEATS ? `<button id="btn-add-seat">+ ADD HAND</button>` : ''}
          <button id="btn-deal" class="primary" ${canDeal ? '' : 'disabled'}>DEAL ${State.setupSeats.length === 1 ? 'HAND' : 'HANDS'}</button>
        </div>
      </div>
    `;

    // Wire events
    document.querySelectorAll('[data-seat]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.dataset.rm) return; // handled below
        State.selectedSeat = Number(el.dataset.seat);
        renderSetup();
      });
    });
    document.querySelectorAll('[data-rm]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const idx = Number(el.dataset.rm);
        State.setupSeats.splice(idx, 1);
        if (State.selectedSeat >= State.setupSeats.length) {
          State.selectedSeat = State.setupSeats.length - 1;
        }
        renderSetup();
      });
    });
    document.querySelectorAll('[data-chip]').forEach(el => {
      el.addEventListener('click', () => {
        const v = Number(el.dataset.chip);
        const i = State.selectedSeat;
        if (i < 0 || i >= State.setupSeats.length) return;
        State.setupSeats[i] = (State.setupSeats[i] || 0) + v;
        renderSetup();
      });
    });
    document.querySelector('[data-clear]')?.addEventListener('click', () => {
      const i = State.selectedSeat;
      if (i < 0 || i >= State.setupSeats.length) return;
      State.setupSeats[i] = 0;
      renderSetup();
    });
    $('btn-add-seat')?.addEventListener('click', () => {
      if (State.setupSeats.length >= MAX_SEATS) return;
      State.setupSeats.push(0);
      State.selectedSeat = State.setupSeats.length - 1;
      renderSetup();
    });
    $('btn-deal').addEventListener('click', deal);
  }

  // ── Play view (one or more active/finished hands) ───────────────────
  function renderHands() {
    const count = State.hands.length || 1;
    const row = $('seats-row');
    row.style.setProperty('--seat-count', count);
    row.innerHTML = State.hands.map((h, idx) => seatHtml(h, idx)).join('');

    // Dealer cards — share the dealer view across all hands. While ANY
    // hand is still active the dealer's hole card must stay hidden, so we
    // pick the most-hidden view available.
    const dealerVisible = pickDealerView(State.hands);
    $('dealer-cards').innerHTML = dealerVisible.cards.map(renderCard).join('');
    $('dealer-val').textContent = dealerVisible.valueLabel;

    // Per-seat buttons
    State.hands.forEach((h, i) => {
      if (h.status !== 'active') return;
      const root = document.querySelector(`[data-handseat="${i}"]`);
      root?.querySelector('.b-hit')?.addEventListener('click', () => act('hit', h.id));
      root?.querySelector('.b-stand')?.addEventListener('click', () => act('stand', h.id));
      root?.querySelector('.b-double')?.addEventListener('click', () => act('double', h.id));
    });

    // Setup area shows the NEW HAND button only if all hands are settled.
    const allDone = State.hands.every(h => h.status !== 'active');
    if (allDone) {
      $('setup-area').innerHTML = `
        <div class="setup-actions">
          <button class="primary" id="btn-new">NEW HAND</button>
        </div>
      `;
      $('btn-new').addEventListener('click', () => {
        State.hands = [];
        State.setupSeats = [Math.max(MIN_BET, State.setupSeats[0] || 25)];
        State.selectedSeat = 0;
        renderSetup();
        refreshBalance();
      });
      refreshBalance();
    } else {
      $('setup-area').innerHTML = '';
    }
  }

  function pickDealerView(hands) {
    // If at least one hand is active, show dealer's hidden hole card.
    const anyActive = hands.some(h => h.status === 'active');
    // Pull from the first hand — backend keeps dealer state consistent.
    const h = hands[0];
    if (!h) return { cards: [], valueLabel: '' };
    if (anyActive) {
      // Server already returns the hidden form when status === 'active'.
      const activeHand = hands.find(x => x.status === 'active');
      return {
        cards: activeHand.dealerCards,
        valueLabel: `Showing ${activeHand.dealerValue}+`,
      };
    }
    return {
      cards: h.dealerCards,
      valueLabel: `Total: ${h.dealerValue}`,
    };
  }

  function seatHtml(h, idx) {
    const isActive = h.status === 'active';
    const cls = h.status === 'won' || h.outcome === 'win' || h.outcome === 'blackjack' ? 'is-win'
              : h.status === 'player_bust' || h.outcome === 'lose' ? 'is-bust'
              : isActive ? 'is-active' : '';
    const banner = isActive
      ? `<div class="banner">Your move</div>`
      : (() => {
          let txt = '', c = '';
          switch (h.outcome) {
            case 'blackjack': c='win';  txt = `BLACKJACK! +${h.payout} cr`; break;
            case 'win':       c='win';  txt = `WIN +${h.payout} cr`; break;
            case 'lose':      c='lose'; txt = `LOSE`; break;
            case 'push':      c='push'; txt = `PUSH — refunded`; break;
            default:          txt = h.status;
          }
          return `<div class="banner ${c}">${txt}</div>`;
        })();
    const buttons = isActive ? `
      <div class="seat-controls">
        <button class="b-hit green">HIT</button>
        <button class="b-stand red">STAND</button>
        ${h.playerCards.length === 2 ? `<button class="b-double gold">DOUBLE +${h.bet}</button>` : ''}
      </div>
    ` : '';
    return `
      <div class="player-seat ${cls}" data-handseat="${idx}">
        <div class="seat-tag">SEAT ${idx + 1}</div>
        <div class="seat-bet">${h.bet} cr</div>
        <div class="cards">${h.playerCards.map(renderCard).join('')}</div>
        <div class="val">Total: ${h.playerValue}</div>
        ${banner}
        ${buttons}
      </div>
    `;
  }

  // ── Server interactions ─────────────────────────────────────────────
  async function deal() {
    try {
      const bets = State.setupSeats.filter(b => b >= MIN_BET);
      if (!bets.length) return alert('Place at least one chip on a hand.');
      const r = await api('/api/games/blackjack/start', {
        method: 'POST',
        body: { bets },
      });
      State.hands = r.hands || [];
      renderHands();
      refreshBalance();
    } catch (e) { alert(friendly(e.message)); }
  }

  async function act(kind, handId) {
    try {
      const path = ({
        hit:    '/api/games/blackjack/hit',
        stand:  '/api/games/blackjack/stand',
        double: '/api/games/blackjack/double',
      })[kind];
      const r = await api(path, { method: 'POST', body: { handId } });
      // Patch the updated hand back into our array.
      State.hands = State.hands.map(h => h.id === r.hand.id ? r.hand : h);
      renderHands();
    } catch (e) { alert(friendly(e.message)); }
  }

  async function refreshBalance() {
    try {
      const { balance } = await api('/api/wallet/balance');
      const el = document.querySelector('.topbar .balance');
      if (el) el.textContent = fmtCredits(balance);
    } catch (_) {}
  }

  function friendly(c) {
    return ({
      insufficient_balance:    'Not enough credits.',
      invalid_bet_amount:      'Each hand must have at least ' + MIN_BET + ' cr on it.',
      too_many_active_hands:   'You can have at most 3 hands at the table.',
      too_many_hands:          'Maximum 3 hands per deal.',
      hand_not_active:         'That hand is no longer active.',
      hand_not_found:          'Hand not found — try a new deal.',
      double_only_on_first_two:'You can only double on the first two cards.',
    })[c] || c;
  }

  // ── Resume any active hands ─────────────────────────────────────────
  try {
    const r = await api('/api/games/blackjack/active');
    if (Array.isArray(r.hands) && r.hands.length) {
      State.hands = r.hands;
      renderHands();
      return;
    }
  } catch (_) {}
  renderSetup();
})();
