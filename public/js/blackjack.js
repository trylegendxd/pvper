// public/js/blackjack.js — multi-hand blackjack, casino-style felt
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const MAX_SEATS = 3;
  const MIN_BET   = 5;
  // Chip palette — matches the on-table rack so the colours are
  // consistent everywhere on screen.
  const CHIPS = [
    { v: 5,    c: '#f0f0f0', tc: '#222' },
    { v: 25,   c: '#2b6fff', tc: '#fff' },
    { v: 100,  c: '#1aa758', tc: '#fff' },
    { v: 500,  c: '#6c2bff', tc: '#fff' },
    { v: 1000, c: '#ffae00', tc: '#222' },
  ];

  const $ = id => document.getElementById(id);

  // ── State ─────────────────────────────────────────────────────────
  const State = {
    phase:        'setup',   // 'setup' | 'play'
    bets:         [0, 0, 0], // current bet on each of 3 seats
    selectedSeat: 0,
    activeChip:   CHIPS[2].v, // default chip = 100
    lastBets:     null,      // for REBET
    balance:      Number(user.balance) || 0,
    hands:        [],
  };

  // ── Animation tracking ────────────────────────────────────────────
  // The renderer re-creates the entire `seats-arc` DOM tree on every
  // state change. Without bookkeeping, every card would re-run the
  // deal-in animation on every hit/stand — a flickery mess. We track
  // per-position counts so the renderer can decide which cards are
  // ACTUALLY new (got drawn this turn) and only animate those.
  let _animState = {
    dealerCount:    0,
    dealerHidden:   false,
    seatCounts:    [0, 0, 0],
    // When true, the NEXT renderPlay() suppresses all animations. Used
    // when the page resumes mid-game so existing cards don't re-deal
    // themselves on page load.
    skipNext:       false,
    // Counter that increments for each fresh card in a single render,
    // used to stagger their animation-delay so they appear one at a
    // time instead of all at once.
    freshIdx:       0,
  };
  function resetAnimState(skipNext = false) {
    _animState = {
      dealerCount: 0, dealerHidden: false,
      seatCounts: [0, 0, 0], skipNext, freshIdx: 0,
    };
  }
  // Compute the CSS class + delay style for a dealer card at index `idx`.
  // Returns the FULL inline attribute string for the card-face element.
  function dealerCardAttrs(c, idx) {
    if (_animState.skipNext) return { cls: '', style: '' };
    // The hole card just transitioned from hidden to revealed — flip it
    // first (delay 0), and let any freshly-drawn dealer cards cascade
    // after it via the shared freshIdx counter.
    if (idx === 1 && _animState.dealerHidden && !c.hidden
        && _animState.dealerCount >= 2) {
      const delay = _animState.freshIdx++ * 90;
      return { cls: 'flipping', style: `animation-delay:${delay}ms;` };
    }
    // Fresh card — it didn't exist in the previous render.
    if (idx >= _animState.dealerCount) {
      const delay = _animState.freshIdx++ * 90;
      return { cls: 'fresh', style: `animation-delay:${delay}ms;` };
    }
    return { cls: '', style: '' };
  }
  function seatCardAttrs(c, seatIdx, cardIdx) {
    if (_animState.skipNext) return { cls: '', style: '' };
    if (cardIdx >= _animState.seatCounts[seatIdx]) {
      const delay = _animState.freshIdx++ * 90;
      return { cls: 'fresh', style: `animation-delay:${delay}ms;` };
    }
    return { cls: '', style: '' };
  }
  function commitAnimState(view, handBySeat) {
    _animState.dealerCount  = view.cards.length;
    _animState.dealerHidden = view.cards.some(c => c.hidden);
    for (let i = 0; i < 3; i++) {
      _animState.seatCounts[i] = handBySeat[i] ? handBySeat[i].playerCards.length : 0;
    }
    _animState.skipNext = false;
    _animState.freshIdx = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function chipFor(v) { return CHIPS.find(c => c.v === v) || CHIPS[0]; }

  // Pick the largest chip <= remaining as the "label" for the stack on
  // the betting circle. The visual is a stack — we just colour by the
  // largest denomination that fits.
  function stackColorFor(total) {
    let c = CHIPS[0];
    for (const x of CHIPS) if (total >= x.v) c = x;
    return c;
  }

  function totalBet() { return State.bets.reduce((a, b) => a + b, 0); }

  function refreshBalance() {
    api('/api/wallet/balance').then(({ balance }) => {
      State.balance = Number(balance) || 0;
      $('bal-display').textContent = fmtCredits(State.balance);
      const tb = $('topbar')?.querySelector('.balance');
      if (tb) tb.textContent = fmtCredits(State.balance);
    }).catch(() => {});
  }

  function renderCard(c, animCls = '', style = '') {
    const styleAttr = style ? ` style="${style}"` : '';
    if (c.hidden) return `<div class="card-face hidden ${animCls}"${styleAttr}></div>`;
    const red = (c.s === '♥' || c.s === '♦');
    return `<div class="card-face ${red ? 'red' : ''} ${animCls}"${styleAttr}>
      <span>${c.r}${c.s}</span>
      <span class="bot">${c.r}${c.s}</span>
    </div>`;
  }

  // Pretty money — uses k/m suffixes only in chip stacks to keep them tight.
  function chipLabel(v) {
    if (v >= 1000 && v % 1000 === 0) return (v / 1000) + 'k';
    return String(v);
  }

  // ── Setup-phase render ────────────────────────────────────────────
  function renderSetup() {
    State.phase = 'setup';
    // No cards on the table during setup, so the next renderPlay (after
    // DEAL) sees zero pre-existing cards → everything animates in.
    resetAnimState(false);
    $('dealer-cards').innerHTML = '';
    $('dealer-val').textContent = '';
    $('bj-table-text').style.display = '';
    $('total-bet-display').textContent = fmtCredits(totalBet());

    // Three seats, each empty (no cards), with a betting circle below.
    $('seats-arc').innerHTML = State.bets.map((bet, i) => {
      const isSel = i === State.selectedSeat;
      const hasBet = bet > 0;
      return `
        <div class="seat-slot" data-seat="${i}">
          <div class="seat-cards"></div>
          <div class="seat-val"></div>
          <div class="seat-banner"></div>
          <div class="bet-circle ${isSel ? 'is-selected' : ''}" data-bet-circle="${i}">
            ${hasBet
              ? `<div class="chip-stack" style="--c:${stackColorFor(bet).c}">
                   <div class="chip-face"><span class="chip-amount">${chipLabel(bet)}</span></div>
                 </div>`
              : `<span class="add-hand-label">CLICK<br>TO BET</span>`}
          </div>
        </div>
      `;
    }).join('');

    // Bottom rail: chip selector + actions
    $('bj-bottom').innerHTML = `
      <div class="chip-row">
        ${CHIPS.map(c => `
          <button class="chip-btn ${c.v === State.activeChip ? 'is-active' : ''}"
                  data-chip="${c.v}"
                  style="--c:${c.c};color:${c.tc};">
            ${chipLabel(c.v)}
          </button>
        `).join('')}
      </div>
      <div class="action-row">
        <button class="action-btn" id="btn-clear">CLEAR</button>
        ${State.lastBets ? `<button class="action-btn" id="btn-rebet">REBET</button>` : ''}
        <button class="action-btn" id="btn-double" ${totalBet() > 0 ? '' : 'disabled'}>×2</button>
        <button class="action-btn primary" id="btn-deal" ${totalBet() >= MIN_BET ? '' : 'disabled'}>DEAL</button>
      </div>
    `;

    wireSetup();
  }

  function wireSetup() {
    // Seat / betting-circle selection
    document.querySelectorAll('[data-bet-circle]').forEach(el => {
      el.addEventListener('click', () => {
        State.selectedSeat = Number(el.dataset.betCircle);
        renderSetup();
      });
    });
    // Chip selection
    document.querySelectorAll('[data-chip]').forEach(el => {
      el.addEventListener('click', () => {
        const v = Number(el.dataset.chip);
        State.activeChip = v;
        // Also place this chip on the currently-selected seat.
        if (State.bets[State.selectedSeat] + v > State.balance - (totalBet() - State.bets[State.selectedSeat])) {
          // Soft guard — still allow it; server will reject if truly short.
        }
        State.bets[State.selectedSeat] = (State.bets[State.selectedSeat] || 0) + v;
        renderSetup();
      });
    });
    $('btn-clear')?.addEventListener('click', () => {
      State.bets = [0, 0, 0];
      renderSetup();
    });
    $('btn-rebet')?.addEventListener('click', () => {
      if (!State.lastBets) return;
      State.bets = [
        State.lastBets[0] || 0,
        State.lastBets[1] || 0,
        State.lastBets[2] || 0,
      ];
      renderSetup();
    });
    $('btn-double')?.addEventListener('click', () => {
      State.bets = State.bets.map(b => b * 2);
      renderSetup();
    });
    $('btn-deal')?.addEventListener('click', deal);
  }

  // ── Play-phase render ─────────────────────────────────────────────
  function renderPlay() {
    State.phase = 'play';
    $('bj-table-text').style.display = 'none';

    // Dealer — share the dealer view across all hands. Each card asks
    // _animState whether it's new / a hole-card reveal so only the cards
    // that actually changed this turn animate.
    const view = pickDealerView(State.hands);
    $('dealer-cards').innerHTML = view.cards.map((c, idx) => {
      const a = dealerCardAttrs(c, idx);
      return renderCard(c, a.cls, a.style);
    }).join('');
    $('dealer-val').textContent = view.valueLabel;

    // Build the seats: one per ACTUAL hand. Empty seats are locked.
    // We keep three slots so layout stays balanced.
    const handBySeat = [null, null, null];
    State.hands.forEach((h, idx) => { if (idx < 3) handBySeat[idx] = h; });
    const lockedBet = State.lastBets || [0, 0, 0];

    $('seats-arc').innerHTML = handBySeat.map((h, i) => {
      if (!h) {
        // Empty seat — show a faded indicator if this seat had a bet.
        const placeholder = lockedBet[i] > 0
          ? `<div class="chip-stack" style="--c:${stackColorFor(lockedBet[i]).c};opacity:.25;">
               <div class="chip-face"><span class="chip-amount">${chipLabel(lockedBet[i])}</span></div>
             </div>`
          : `<span class="add-hand-label">—</span>`;
        return `
          <div class="seat-slot is-locked" data-seat="${i}">
            <div class="seat-cards"></div>
            <div class="seat-val"></div>
            <div class="seat-banner"></div>
            <div class="bet-circle is-locked">${placeholder}</div>
          </div>
        `;
      }
      const isActive = h.status === 'active';
      const bannerCls = bannerClassFor(h);
      const bannerText = bannerTextFor(h);
      const buttons = isActive ? `
        <div class="seat-actions" data-handseat="${i}">
          <button class="b-hit green">HIT</button>
          <button class="b-stand red">STAND</button>
          ${h.playerCards.length === 2 && State.balance >= h.bet ? `<button class="b-double gold">×2 +${h.bet}</button>` : ''}
        </div>
      ` : '';
      const cardsHtml = h.playerCards.map((c, cardIdx) => {
        const a = seatCardAttrs(c, i, cardIdx);
        return renderCard(c, a.cls, a.style);
      }).join('');
      return `
        <div class="seat-slot" data-handseat="${i}">
          <div class="seat-cards">${cardsHtml}</div>
          <div class="seat-val">${h.playerValue}</div>
          <div class="seat-banner ${bannerCls}">${bannerText}</div>
          <div class="bet-circle is-locked">
            <div class="chip-stack" style="--c:${stackColorFor(h.bet).c}">
              <div class="chip-face"><span class="chip-amount">${chipLabel(h.bet)}</span></div>
            </div>
          </div>
          ${buttons}
        </div>
      `;
    }).join('');

    // Snapshot the card counts so the NEXT render knows which cards are
    // pre-existing (and therefore shouldn't re-animate).
    commitAnimState(view, handBySeat);

    // Wire per-seat buttons
    State.hands.forEach((h, i) => {
      if (h.status !== 'active') return;
      const root = document.querySelector(`[data-handseat="${i}"] .seat-actions`);
      root?.querySelector('.b-hit')   ?.addEventListener('click', () => act('hit', h.id));
      root?.querySelector('.b-stand') ?.addEventListener('click', () => act('stand', h.id));
      root?.querySelector('.b-double')?.addEventListener('click', () => act('double', h.id));
    });

    // Bottom rail — NEW HAND when every seat is settled, otherwise empty.
    const allDone = State.hands.every(h => h.status !== 'active');
    if (allDone) {
      $('bj-bottom').innerHTML = `
        <div class="action-row">
          <button class="action-btn primary" id="btn-new">NEW HAND</button>
          ${State.lastBets ? `<button class="action-btn" id="btn-rebet-now">REBET (${fmtCredits(State.lastBets.reduce((a,b)=>a+b,0))})</button>` : ''}
        </div>
      `;
      $('btn-new').addEventListener('click', () => {
        State.bets = [0, 0, 0];
        State.hands = [];
        renderSetup();
        refreshBalance();
      });
      $('btn-rebet-now')?.addEventListener('click', () => {
        State.bets = [...State.lastBets];
        State.hands = [];
        renderSetup();
      });
      refreshBalance();
    } else {
      $('bj-bottom').innerHTML = '';
    }

    $('total-bet-display').textContent = fmtCredits(State.hands.reduce((a,h) => a + h.bet, 0));
  }

  function pickDealerView(hands) {
    if (!hands.length) return { cards: [], valueLabel: '' };
    const anyActive = hands.some(h => h.status === 'active');
    const h = anyActive ? hands.find(x => x.status === 'active') : hands[0];
    return {
      cards: h.dealerCards,
      valueLabel: anyActive ? `Showing ${h.dealerValue}+` : `Total: ${h.dealerValue}`,
    };
  }

  function bannerClassFor(h) {
    if (h.status === 'active') return 'active';
    // A hand that's done its part but is waiting for the dealer (because
    // sibling hands are still being played) has no outcome yet — keep it
    // neutral rather than flashing a win/lose colour prematurely.
    if (!h.outcome) return 'active';
    if (h.outcome === 'win' || h.outcome === 'blackjack') return 'win';
    if (h.outcome === 'push') return 'push';
    return 'lose';
  }
  function bannerTextFor(h) {
    if (h.status === 'active') return 'YOUR MOVE';
    // Settled outcomes first.
    switch (h.outcome) {
      case 'blackjack': return `BLACKJACK +${h.payout}`;
      case 'win':       return `WIN +${h.payout}`;
      case 'lose':      return h.status === 'player_bust' ? 'BUST' : 'DEALER WINS';
      case 'push':      return 'PUSH';
    }
    // No outcome yet — the player has finished this hand but the dealer
    // hasn't resolved it (still playing other hands). Show a clear
    // interim label instead of the raw DB status string.
    if (h.status === 'player_stand') return 'STANDING…';
    if (h.status === 'player_bust')  return 'BUST';
    return 'WAITING…';
  }

  // ── Server interactions ───────────────────────────────────────────
  async function deal() {
    try {
      const bets = State.bets.filter(b => b >= MIN_BET);
      if (!bets.length) return alert('Place at least one chip on a hand.');
      const r = await api('/api/games/blackjack/start', {
        method: 'POST',
        body: { bets },
      });
      // Remember the bet shape for REBET.
      State.lastBets = [...State.bets];
      State.hands = r.hands || [];
      renderPlay();
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
      // Prefer the full round snapshot — when this action made the dealer
      // play, every sibling hand was just settled server-side and needs
      // to refresh. Fall back to patching the single hand for any old
      // response shape.
      if (Array.isArray(r.hands) && r.hands.length) {
        State.hands = r.hands;
      } else if (r.hand) {
        State.hands = State.hands.map(h => h.id === r.hand.id ? r.hand : h);
      }
      renderPlay();
      // If the whole round is now settled, the balance changed (payouts).
      if (State.hands.every(h => h.status !== 'active')) refreshBalance();
    } catch (e) { alert(friendly(e.message)); }
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

  // ── Initial state: resume any active hands, else show setup ──────
  $('bal-display').textContent = fmtCredits(State.balance);
  try {
    const r = await api('/api/games/blackjack/active');
    if (Array.isArray(r.hands) && r.hands.length) {
      State.hands = r.hands;
      // Reconstruct lastBets from the active hands so REBET stays meaningful.
      State.lastBets = [0, 0, 0];
      r.hands.forEach((h, i) => { if (i < 3) State.lastBets[i] = h.bet; });
      // Resuming a game on page load — suppress the deal-in animation so
      // the already-dealt cards just appear instead of flying in.
      resetAnimState(true);
      renderPlay();
      refreshBalance();
      return;
    }
  } catch (_) {}
  renderSetup();
  refreshBalance();
})();
