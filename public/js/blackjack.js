// public/js/blackjack.js
(async () => {
  const user = await renderTopbar();
  if (!user) return;
  document.getElementById('player-name').textContent = user.username.toUpperCase();

  const $ = id => document.getElementById(id);
  let currentHand = null;

  function renderCard(c) {
    if (c.hidden) return `<div class="card-face hidden"></div>`;
    const red = (c.s === '♥' || c.s === '♦');
    return `<div class="card-face ${red ? 'red' : ''}">
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
          <div><label style="font-size:11px;color:#cdd; letter-spacing:1px;">BET</label>
            <input id="bet" type="number" min="1" value="25"></div>
          <button class="btn" id="deal-btn">DEAL</button>
        </div>`;
      $('deal-btn').addEventListener('click', deal);
      return;
    }
    $('dealer-cards').innerHTML = currentHand.dealerCards.map(renderCard).join('');
    $('player-cards').innerHTML = currentHand.playerCards.map(renderCard).join('');
    $('dealer-val').textContent = `Total: ${currentHand.dealerValue}${currentHand.status === 'active' ? '+' : ''}`;
    $('player-val').textContent = `Total: ${currentHand.playerValue}`;

    if (currentHand.status === 'active') {
      $('banner').textContent = `Bet ${currentHand.bet} cr — your move`;
      $('banner').className = 'banner';
      $('controls').innerHTML = `
        <button class="btn green" id="hit-btn">HIT</button>
        <button class="btn red"   id="stand-btn">STAND</button>`;
      $('hit-btn').addEventListener('click', doHit);
      $('stand-btn').addEventListener('click', doStand);
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
      currentHand = hand; render();
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

  async function refreshBalance() {
    try {
      const { balance } = await api('/api/wallet/balance');
      const el = document.querySelector('.topbar .balance');
      if (el) el.textContent = fmtCredits(balance);
    } catch (_) {}
  }

  function friendly(c) {
    return ({
      insufficient_balance:'Not enough credits.',
      invalid_bet_amount:'Bet must be a positive integer.',
      hand_already_active:'Finish your current hand first.',
    })[c] || c;
  }

  // Resume any active hand
  const { hand } = await api('/api/games/blackjack/active');
  if (hand) currentHand = hand;
  render();
})();
