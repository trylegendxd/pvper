// public/js/blackjack.js — Stake-style single-hand blackjack with split.
//
// Layout: dealer hand fanned at the top of the felt, the player's
// hand(s) fanned at the bottom, a 2×2 action grid (Hit / Stand / Split /
// Double), and a bet row with ½ / 2× helpers + a big green BET button.
//
// The backend still supports multiple hands per round — splitting a pair
// just adds another hand to the same round. Actions always apply to the
// "current" hand (the left-most one still active); when it finishes,
// focus moves right, and once nothing is active the dealer plays.
(async () => {
  const user = await renderTopbar();
  if (!user) return;

  const MIN_BET   = 5;
  const MAX_HANDS = 4;
  const $ = id => document.getElementById(id);

  // Card fan geometry (px). Kept in JS so the fan container can be sized
  // to exactly wrap its absolutely-positioned cards.
  const CARD_W = 60, CARD_H = 84, OFF_X = 30, OFF_Y = 14;

  const State = {
    phase:   'idle',   // 'idle' (can bet) | 'play' (hand in progress/just ended)
    balance: Number(user.balance) || 0,
    hands:   [],       // array of server hand views
    lastBet: null,     // remember last stake for convenience
    busy:    false,
  };

  // ── Animation bookkeeping ─────────────────────────────────────────
  // Only animate cards that are genuinely new this render (and the hole
  // card on reveal), so hitting/standing doesn't re-deal the whole table.
  let _anim = { dealer: 0, dealerHidden: false, hands: {}, skip: false, fresh: 0 };
  function resetAnim(skip) { _anim = { dealer: 0, dealerHidden: false, hands: {}, skip: !!skip, fresh: 0 }; }

  // ── Helpers ───────────────────────────────────────────────────────
  function isRed(s) { return s === '♥' || s === '♦'; }
  function splitValue(c) {
    if (['J', 'Q', 'K', '10'].includes(c.r)) return 10;
    if (c.r === 'A') return 11;
    return Number(c.r);
  }
  function currentHand() { return State.hands.find(h => h.status === 'active') || null; }
  function roundOver() { return State.hands.length > 0 && State.hands.every(h => h.status !== 'active'); }

  function refreshBalance() {
    api('/api/wallet/balance').then(({ balance }) => {
      State.balance = Number(balance) || 0;
      $('bj-balance').textContent = fmtCredits(State.balance);
      const tb = $('topbar')?.querySelector('.balance');
      if (tb) tb.textContent = fmtCredits(State.balance);
      syncActions();
    }).catch(() => {});
  }

  function showMsg(text, kind) {
    const el = $('bj-msg');
    el.className = 'bj-msg ' + (kind || '');
    el.textContent = text;
    if (kind === 'ok') { clearTimeout(showMsg._t); showMsg._t = setTimeout(() => { el.className = 'bj-msg'; }, 2600); }
  }

  // ── Card / fan rendering ──────────────────────────────────────────
  function cardFaceHTML(c) {
    return `<div class="r-top">${c.r}<br>${c.s}</div>
            <div class="r-suit">${c.s}</div>
            <div class="r-bot">${c.r}<br>${c.s}</div>`;
  }
  // animFor(i, card) → { cls, delay } for the card at index i
  function buildFan(cards, animFor) {
    const fan = document.createElement('div');
    fan.className = 'bj-fan';
    cards.forEach((c, i) => {
      const card = document.createElement('div');
      card.className = 'bj-card'
        + (c.hidden ? ' back' : '')
        + (!c.hidden && isRed(c.s) ? ' red' : '');
      card.style.left = (i * OFF_X) + 'px';
      card.style.top  = (i * OFF_Y) + 'px';
      card.style.zIndex = String(i + 1);
      if (!c.hidden) card.innerHTML = cardFaceHTML(c);
      const a = animFor ? animFor(i, c) : null;
      if (a && a.cls) { card.classList.add(a.cls); if (a.delay) card.style.animationDelay = a.delay + 'ms'; }
      fan.appendChild(card);
    });
    const n = Math.max(1, cards.length);
    fan.style.width  = (CARD_W + (n - 1) * OFF_X) + 'px';
    fan.style.height = (CARD_H + (n - 1) * OFF_Y) + 'px';
    return fan;
  }

  function dealerView() {
    if (!State.hands.length) return { cards: [], value: '' };
    const anyActive = State.hands.some(h => h.status === 'active');
    const h = anyActive ? State.hands.find(x => x.status === 'active') : State.hands[0];
    return { cards: h.dealerCards || [], value: h.dealerValue };
  }

  function dealerAnimFor(i, c) {
    if (_anim.skip) return null;
    // Hole card reveal — flip it (delay 0), drawn cards cascade after.
    if (i === 1 && _anim.dealerHidden && !c.hidden && _anim.dealer >= 2) {
      return { cls: 'flip', delay: (_anim.fresh++) * 90 };
    }
    if (i >= _anim.dealer) return { cls: 'deal', delay: (_anim.fresh++) * 90 };
    return null;
  }
  function handAnimFor(h) {
    const prev = _anim.hands[h.id] || 0;
    return (i) => {
      if (_anim.skip) return null;
      if (i >= prev) return { cls: 'deal', delay: (_anim.fresh++) * 90 };
      return null;
    };
  }

  // ── Main render ───────────────────────────────────────────────────
  function render() {
    const dealer = dealerView();
    const focus  = currentHand();

    // Dealer
    const dHost = $('bj-dealer');
    dHost.innerHTML = '';
    if (dealer.cards.length) {
      const hand = document.createElement('div');
      hand.className = 'bj-hand';
      const pill = document.createElement('div');
      pill.className = 'bj-pill';
      pill.textContent = dealer.value != null ? dealer.value : '';
      hand.appendChild(pill);
      hand.appendChild(buildFan(dealer.cards, dealerAnimFor));
      dHost.appendChild(hand);
    }

    // Players (one fan per hand; splits sit side-by-side)
    const pHost = $('bj-players');
    pHost.innerHTML = '';
    for (const h of State.hands) {
      const el = document.createElement('div');
      let cls = 'bj-hand is-player';
      if (h.status !== 'active') {
        if (h.outcome === 'win' || h.outcome === 'blackjack') cls = 'bj-hand is-win';
        else if (h.outcome === 'push') cls = 'bj-hand is-push';
        else if (h.outcome) cls = 'bj-hand is-lose';
        else cls = 'bj-hand'; // finished but dealer not resolved yet
      }
      if (focus && h.id === focus.id && State.hands.length > 1) cls += ' is-focus';
      el.className = cls;
      const pill = document.createElement('div');
      pill.className = 'bj-pill';
      pill.textContent = pillText(h);
      el.appendChild(pill);
      el.appendChild(buildFan(h.playerCards || [], handAnimFor(h)));
      pHost.appendChild(el);
    }

    // Commit animation snapshot for the NEXT render.
    _anim.dealer = dealer.cards.length;
    _anim.dealerHidden = dealer.cards.some(c => c.hidden);
    _anim.hands = {};
    for (const h of State.hands) _anim.hands[h.id] = (h.playerCards || []).length;
    _anim.skip = false; _anim.fresh = 0;

    syncActions();
  }

  function pillText(h) {
    if (h.status === 'active') return h.playerValue;
    switch (h.outcome) {
      case 'blackjack': return 'BJ';
      case 'win':  return `${h.playerValue} ✓`;
      case 'push': return `${h.playerValue} =`;
      case 'lose': return h.status === 'player_bust' ? 'BUST' : `${h.playerValue}`;
      default:     return h.playerValue;
    }
  }

  // ── Action button state ───────────────────────────────────────────
  function syncActions() {
    const h = currentHand();
    const canAct = !!h && !State.busy;
    const two = !!h && (h.playerCards || []).length === 2;
    const pair = two && splitValue(h.playerCards[0]) === splitValue(h.playerCards[1]);

    $('act-hit').disabled    = !canAct;
    $('act-stand').disabled  = !canAct;
    $('act-double').disabled = !(canAct && two && State.balance >= h.bet);
    $('act-split').disabled  = !(canAct && two && pair && State.balance >= h.bet && State.hands.length < MAX_HANDS);

    // BET enabled only when no hand is in progress.
    const amount = getAmount();
    const canBet = !State.busy && currentHand() == null
                   && amount >= MIN_BET && amount <= State.balance;
    const betBtn = $('bj-bet');
    betBtn.disabled = !canBet;
    betBtn.textContent = State.hands.length && roundOver() ? 'BET AGAIN' : 'BET';
  }

  // ── Result toast ──────────────────────────────────────────────────
  function maybeShowResult() {
    if (!roundOver()) return;
    const totalBet    = State.hands.reduce((a, h) => a + Number(h.bet || 0), 0);
    const totalPayout = State.hands.reduce((a, h) => a + Number(h.payout || 0), 0);
    const net = totalPayout - totalBet;
    const multi = State.hands.length > 1;
    const el = $('bj-result');
    const kind = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
    const head = net > 0 ? 'YOU WIN'
               : net < 0 ? (allBusted() ? 'BUST' : 'DEALER WINS')
               : (multi ? 'BREAK EVEN' : 'PUSH');
    el.className = 'bj-result ' + kind;
    el.innerHTML = `${head}<span class="amt">${net >= 0 ? '+' : ''}${fmtCredits(net)}</span>`;
    el.classList.add('show');
    clearTimeout(maybeShowResult._t);
    maybeShowResult._t = setTimeout(() => el.classList.remove('show'), 2800);
  }
  function allBusted() { return State.hands.every(h => h.status === 'player_bust'); }
  function hideResult() { const el = $('bj-result'); el.classList.remove('show'); }

  // ── Bet amount controls ───────────────────────────────────────────
  const amountEl = $('bj-amount');
  function getAmount() { return Math.max(0, Math.floor(Number(amountEl.value) || 0)); }
  function setAmount(n) {
    const v = Math.max(0, Math.floor(n || 0));
    amountEl.value = v;
    syncActions();
  }
  amountEl.addEventListener('input', syncActions);
  $('bj-half').addEventListener('click', () => setAmount(Math.floor(getAmount() / 2)));
  $('bj-2x').addEventListener('click',   () => setAmount(Math.min(State.balance, getAmount() * 2)));

  // ── Server actions ────────────────────────────────────────────────
  async function deal() {
    if (State.busy) return;
    const amount = getAmount();
    if (amount < MIN_BET) return showMsg(`Minimum bet is ${MIN_BET} cr.`, 'error');
    if (amount > State.balance) return showMsg('Not enough credits.', 'error');
    State.busy = true; hideResult(); syncActions();
    try {
      const r = await api('/api/games/blackjack/start', { method: 'POST', body: { bets: [amount] } });
      State.lastBet = amount;
      State.hands = r.hands || [];
      State.phase = 'play';
      resetAnim(false);          // animate the opening deal
      render();
      maybeShowResult();         // instant blackjack resolves on deal
      refreshBalance();
    } catch (e) { showMsg(friendly(e.message), 'error'); }
    finally { State.busy = false; syncActions(); }
  }

  async function act(kind) {
    const h = currentHand();
    if (!h || State.busy) return;
    const path = {
      hit:    '/api/games/blackjack/hit',
      stand:  '/api/games/blackjack/stand',
      double: '/api/games/blackjack/double',
      split:  '/api/games/blackjack/split',
    }[kind];
    State.busy = true; syncActions();
    try {
      const r = await api(path, { method: 'POST', body: { handId: h.id } });
      if (Array.isArray(r.hands) && r.hands.length) State.hands = r.hands;
      else if (r.hand) State.hands = State.hands.map(x => x.id === r.hand.id ? r.hand : x);
      render();
      if (roundOver()) { maybeShowResult(); refreshBalance(); }
      else refreshBalance(); // split/double change balance mid-round
    } catch (e) { showMsg(friendly(e.message), 'error'); }
    finally { State.busy = false; syncActions(); }
  }

  $('act-hit').addEventListener('click',    () => act('hit'));
  $('act-stand').addEventListener('click',  () => act('stand'));
  $('act-double').addEventListener('click', () => act('double'));
  $('act-split').addEventListener('click',  () => act('split'));
  $('bj-bet').addEventListener('click', () => {
    // BET AGAIN clears the felt first so the new deal animates cleanly.
    if (roundOver()) { State.hands = []; render(); }
    deal();
  });

  // Keyboard shortcuts (CS-style muscle memory): H/S/D, Space = bet.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'KeyH' && !$('act-hit').disabled)    act('hit');
    if (e.code === 'KeyS' && !$('act-stand').disabled)  act('stand');
    if (e.code === 'KeyD' && !$('act-double').disabled) act('double');
    if (e.code === 'KeyP' && !$('act-split').disabled)  act('split');
    if (e.code === 'Space' && !$('bj-bet').disabled) { e.preventDefault(); $('bj-bet').click(); }
  });

  function friendly(c) {
    return ({
      insufficient_balance:     'Not enough credits.',
      invalid_bet_amount:       'Minimum bet is ' + MIN_BET + ' cr.',
      hand_already_active:      'Finish your current hand first.',
      hand_not_active:          'That hand is no longer active.',
      hand_not_found:           'Hand not found — start a new deal.',
      double_only_on_first_two: 'You can only double on the first two cards.',
      split_only_on_first_two:  'You can only split the first two cards.',
      not_a_pair:               'You can only split a matching pair.',
      too_many_splits:          'You\'ve reached the maximum number of split hands.',
      cannot_split:             'This hand can\'t be split.',
    })[c] || c;
  }

  // ── Boot: resume any active hands, else idle ──────────────────────
  $('bj-balance').textContent = fmtCredits(State.balance);
  setAmount(100);
  try {
    const r = await api('/api/games/blackjack/active');
    if (Array.isArray(r.hands) && r.hands.length) {
      State.hands = r.hands;
      State.phase = 'play';
      resetAnim(true);   // don't fly cards in on a resumed game
      render();
    }
  } catch (_) {}
  syncActions();
  refreshBalance();
})();
