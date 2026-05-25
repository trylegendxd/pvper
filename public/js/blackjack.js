// public/js/blackjack.js — animated blackjack table
(async () => {
  const user = await renderTopbar();
  if (!user) return;
  document.getElementById('player-name').textContent = user.username.toUpperCase();

  const $ = id => document.getElementById(id);
  let currentHand = null;
  let prevPlayerCount = 0, prevDealerCount = 0;

  function renderCard(c, isNew, delayIndex) {
    if (c.hidden) return `<div class="card-face hidden"></div>`;
    const red = (c.s === '♥' || c.s === '♦');
    const animClass = isNew ? '' : '';
    const style = isNew ? `style="animation-delay: ${delayIndex * 110}ms"` : '';
    return `<div class="card-face ${red ? 'red' : ''} ${animClass}" ${style}>
      <span>${c.r}${c.s}</span>
      <span class="bot">${c.r}${c.s}</span>
    </div>`;
  }

  function render() {
    if (!currentHand) {
      $('dealer-cards').innerHTML = '';
      $('player-cards').innerHTML = '';
      $('dealer-val').textContent = '';
      $('player-val').textContent = '';
      $('banner').className = 'banner';
      $('banner').textContent = '';
      $('controls').innerHTML = `
        <div class="bet-row">
          <div><label>BET</label>
            <input id="bet" type="number" min="1" value="25"></div>
          <button class="btn" id="deal-btn">DEAL</button>
        </div>
        <div class="chip-suggest">
          <button data-amt="10">+10</button>
          <button data-amt="25">+25</button>
          <button data-amt="50">+50</button>
          <button data-amt="100">+100</button>
          <button data-amt="500">+500</button>
        </div>`;
      $('deal-btn').addEventListener('click', deal);
      document.querySelectorAll('.chip-suggest button').forEach(b =>
        b.addEventListener('click', () => {
          const inp = $('bet');
          inp.value = String((Number(inp.value) || 0) + Number(b.dataset.amt));
        })
      );
      prevPlayerCount = prevDealerCount = 0;
      return;
    }

    // Animate only the NEW cards (those added since last render)
    const dealerHtml = currentHand.dealerCards.map((c, i) =>
      renderCard(c, i >= prevDealerCount, i - prevDealerCount)
    ).join('');
    const playerHtml = currentHand.playerCards.map((c, i) =>
      renderCard(c, i >= prevPlayerCount, i - prevPlayerCount)
    ).join('');

    $('dealer-cards').innerHTML = dealerHtml;
    $('player-cards').innerHTML = playerHtml;
    $('dealer-val').textContent = `Total: ${currentHand.dealerValue}${currentHand.status === 'active' ? '+ ?' : ''}`;
    $('player-val').textContent = `Total: ${currentHand.playerValue}`;

    prevDealerCount = currentHand.dealerCards.length;
    prevPlayerCount = currentHand.playerCards.length;

    if (currentHand.status === 'active') {
      $('banner').textContent = `Bet ${currentHand.bet} cr — your move`;
      $('banner').className = 'banner';
      const canDouble = currentHand.playerCards.length === 2;
      $('controls').innerHTML = `
        <button class="btn green" id="hit-btn">HIT</button>
        <button class="btn red"   id="stand-btn">STAND</button>
        ${canDouble ? `<button class="btn gold" id="double-btn">DOUBLE (+${currentHand.bet})</button>` : ''}`;
      $('hit-btn').addEventListener('click', doHit);
      $('stand-btn').addEventListener('click', doStand);
      const db = $('double-btn'); if (db) db.addEventListener('click', doDouble);
    } else {
      let cls = '', txt = '';
      switch (currentHand.outcome) {
        case 'blackjack': cls='win';  txt='BLACKJACK! +' + currentHand.payout + ' cr'; break;
        case 'win':       cls='win';  txt='YOU WIN +' + currentHand.payout + ' cr'; break;
        case 'lose':      cls='lose'; txt='DEALER WINS'; break;
        case 'push':      cls='push'; txt='PUSH — bet refunded'; break;
        default:          cls='';     txt = currentHand.status;
      }
      $('banner').className = 'banner ' + cls;
      $('banner').textContent = txt;
      $('controls').innerHTML = `<button class="btn" id="new-btn">NEW HAND</button>`;
      $('new-btn').addEventListener('click', () => { currentHand = null; render(); });
      refreshBalance();
    }
  }

  async function deal() {
    try {
      const bet = Math.floor(Number($('bet').value));
      if (!bet || bet <= 0) return alert('Enter a positive bet.');
      const { hand } = await api('/api/games/blackjack/start', { method:'POST', body: { betAmount: bet } });
      prevPlayerCount = 0; prevDealerCount = 0;
      currentHand = hand; render();
      refreshBalance();
    } catch (e) { alert(friendly(e.message)); }
  }
  async function doHit() {
    try {
      const { hand } = await api('/api/games/blackjack/hit', { method:'POST', body: { handId: currentHand.id } });
      currentHand = hand; render();
    } catch (e) { alert(friendly(e.message)); }
  }
  async function doStand() {
    try {
      const { hand } = await api('/api/games/blackjack/stand', { method:'POST', body: { handId: currentHand.id } });
      currentHand = hand; render();
    } catch (e) { alert(friendly(e.message)); }
  }
  async function doDouble() {
    try {
      const { hand } = await api('/api/games/blackjack/double', { method:'POST', body: { handId: currentHand.id } });
      currentHand = hand; render();
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
      insufficient_balance: 'Not enough credits.',
      invalid_bet_amount:   'Bet must be a positive integer.',
      hand_already_active:  'Finish your current hand first.',
      hand_not_active:      'That hand is no longer active.',
      hand_not_found:       'Hand not found — try a new deal.',
      double_only_on_first_two: 'You can only double on your first two cards.',
    })[c] || c;
  }

  // Resume any active hand
  try {
    const { hand } = await api('/api/games/blackjack/active');
    if (hand) { currentHand = hand; prevPlayerCount = hand.playerCards.length; prevDealerCount = hand.dealerCards.length; }
  } catch (_) {}
  render();
})();
