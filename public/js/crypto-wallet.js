// public/js/crypto-wallet.js
// ============================================================================
//  USDC (Base) deposit + withdrawal UI for the wallet page.
//
//  Renders into #crypto-root. Does nothing unless the backend reports
//  CRYPTO_ENABLED=true. ethers is lazy-loaded from a CDN only when enabled,
//  so the play-money-only deployment ships nothing extra.
//
//  The private treasury key lives ONLY on the server — this file never sees
//  it. Deposits are plain USDC.transfer() calls from the user's own wallet;
//  the resulting tx hash is captured and handed to the backend, which does
//  all verification + crediting.
// ============================================================================
(function () {
  const root = document.getElementById('crypto-root');
  if (!root) return;

  const ETHERS_CDN = 'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js';
  let ethers = null;
  let cfg = null;
  let provider = null, signer = null, account = null;

  const $ = (sel, el = root) => el.querySelector(sel);
  const fmt = (n) => Number(n || 0).toLocaleString();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

  function loadEthers() {
    return new Promise((resolve, reject) => {
      if (window.ethers) return resolve(window.ethers);
      const s = document.createElement('script');
      s.src = ETHERS_CDN;
      s.onload = () => resolve(window.ethers);
      s.onerror = () => reject(new Error('Failed to load ethers from CDN'));
      document.head.appendChild(s);
    });
  }

  async function start() {
    try { cfg = await api('/api/crypto/config'); }
    catch (_) { return; }
    if (!cfg || !cfg.enabled) {
      // Feature off — show a tiny disabled note (or nothing) and stop.
      root.innerHTML = `
        <div class="card" style="opacity:.75;">
          <div style="font-size:14px;letter-spacing:2px;color:var(--dim);">CRYPTO WALLET</div>
          <div style="font-size:13px;color:var(--dim);margin-top:8px;">
            Crypto deposits &amp; withdrawals are currently disabled.
          </div>
        </div>`;
      return;
    }
    try { ethers = await loadEthers(); }
    catch (e) { root.innerHTML = `<div class="card">Crypto unavailable: ${esc(e.message)}</div>`; return; }
    renderShell();
    wire();
    refreshAll();
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function renderShell() {
    const netLabel = cfg.network === 'base' ? 'Base (mainnet)' : 'Base Sepolia (testnet)';
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
          <h3 style="font-size:16px;letter-spacing:2px;color:#fff;margin:0;">CRYPTO WALLET · USDC</h3>
          <span style="font-size:12px;color:var(--dim);letter-spacing:1px;">${esc(netLabel)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0;">
          <div class="cw-stat"><div class="l">Conversion</div><div class="v">1 USDC = ${cfg.usdcToCreditsRate} credits</div></div>
          <div class="cw-stat"><div class="l">Min deposit</div><div class="v">${cfg.minDepositUsdc} USDC</div></div>
          <div class="cw-stat"><div class="l">Min withdraw</div><div class="v">${cfg.minWithdrawUsdc} USDC</div></div>
          <div class="cw-stat"><div class="l">Treasury</div><div class="v" style="font-family:monospace;font-size:11px;">${esc(short(cfg.treasuryAddress))}</div></div>
        </div>

        <div class="cw-warn">
          ⚠ Only send <b>native USDC on ${esc(cfg.network === 'base' ? 'Base' : 'Base Sepolia')}</b>.
          Do <b>not</b> send ETH, USDT, SOL, or USDC on another chain — wrong-chain or
          wrong-token transfers may be <b>unrecoverable</b>. This involves real-value
          crypto assets; you are responsible for sending to the correct network.
        </div>

        <!-- Connect / link -->
        <div class="cw-block">
          <div class="cw-row" id="cw-connect-row">
            <button class="cw-btn" id="cw-connect">Connect Wallet</button>
            <span id="cw-account" style="color:var(--dim);font-size:13px;"></span>
          </div>
          <div class="cw-row" id="cw-link-row" style="display:none;margin-top:8px;">
            <button class="cw-btn ghost" id="cw-link">Link Wallet (sign)</button>
            <span id="cw-linked" style="color:#7fd97a;font-size:12px;"></span>
          </div>
        </div>

        <!-- Deposit -->
        <div class="cw-grid">
          <div class="cw-panel">
            <div class="cw-title">Deposit USDC → credits</div>
            <label class="cw-lbl">USDC amount</label>
            <input class="cw-input" id="cw-dep-amt" type="number" min="${cfg.minDepositUsdc}" step="0.01" placeholder="0.00">
            <div class="cw-conv" id="cw-dep-conv">= 0 credits</div>
            <button class="cw-btn primary" id="cw-deposit" disabled>Deposit USDC</button>
            <div class="cw-status" id="cw-dep-status"></div>
          </div>

          <!-- Withdraw -->
          <div class="cw-panel">
            <div class="cw-title">Withdraw credits → USDC</div>
            <label class="cw-lbl">USDC amount</label>
            <input class="cw-input" id="cw-wd-amt" type="number" min="${cfg.minWithdrawUsdc}" step="0.01" placeholder="0.00">
            <div class="cw-conv" id="cw-wd-conv">costs 0 credits</div>
            <label class="cw-lbl">Destination address</label>
            <input class="cw-input" id="cw-wd-addr" type="text" placeholder="0x…" autocomplete="off" spellcheck="false">
            <button class="cw-btn primary" id="cw-withdraw">Request Withdrawal</button>
            <div class="cw-status" id="cw-wd-status"></div>
          </div>
        </div>

        <!-- History -->
        <div class="cw-hist">
          <div>
            <div class="cw-title">Deposits</div>
            <table class="cw-table" id="cw-deposits"><tbody><tr><td class="cw-empty">None yet.</td></tr></tbody></table>
          </div>
          <div>
            <div class="cw-title">Withdrawals</div>
            <table class="cw-table" id="cw-withdrawals"><tbody><tr><td class="cw-empty">None yet.</td></tr></tbody></table>
          </div>
        </div>
      </div>`;
    injectStyles();
  }

  function injectStyles() {
    if (document.getElementById('cw-styles')) return;
    const s = document.createElement('style');
    s.id = 'cw-styles';
    s.textContent = `
      #crypto-root .cw-stat .l { font-size:10px;letter-spacing:2px;color:var(--dim);text-transform:uppercase; }
      #crypto-root .cw-stat .v { font-size:14px;color:#fff;font-weight:700;margin-top:2px; }
      #crypto-root .cw-warn { background:rgba(255,176,48,.07);border:1px solid rgba(255,176,48,.35);
        border-radius:6px;padding:10px 12px;font-size:12px;color:#ffd9a0;line-height:1.5;margin-bottom:14px; }
      #crypto-root .cw-block { margin-bottom:14px; }
      #crypto-root .cw-row { display:flex;align-items:center;gap:12px;flex-wrap:wrap; }
      #crypto-root .cw-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px; }
      #crypto-root .cw-panel { background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:14px; }
      #crypto-root .cw-title { font-size:12px;letter-spacing:2px;color:var(--dim);text-transform:uppercase;margin-bottom:10px; }
      #crypto-root .cw-lbl { display:block;font-size:11px;letter-spacing:1px;color:var(--dim);margin:8px 0 4px; }
      #crypto-root .cw-input { width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.1);color:#fff;padding:9px 12px;font-size:14px;border-radius:4px;font-family:inherit; }
      #crypto-root .cw-input:focus { outline:none;border-color:var(--gold); }
      #crypto-root .cw-conv { font-size:12px;color:#7fd97a;margin:6px 0 10px; }
      #crypto-root .cw-btn { background:#22303f;border:1px solid #3a4558;color:#fff;padding:9px 16px;
        font-size:13px;letter-spacing:1px;border-radius:4px;cursor:pointer;font-family:inherit; }
      #crypto-root .cw-btn:hover:not(:disabled) { background:#2f4459; }
      #crypto-root .cw-btn:disabled { opacity:.45;cursor:not-allowed; }
      #crypto-root .cw-btn.primary { width:100%;background:linear-gradient(180deg,#1fcf5b,#169c46);border:0;color:#04220e;font-weight:700;margin-top:4px; }
      #crypto-root .cw-btn.ghost { background:transparent; }
      #crypto-root .cw-status { font-size:12px;margin-top:8px;min-height:16px;line-height:1.4; }
      #crypto-root .cw-status.ok { color:#7fd97a; } #crypto-root .cw-status.err { color:#ff8080; } #crypto-root .cw-status.wait { color:#ffce4a; }
      #crypto-root .cw-hist { display:grid;grid-template-columns:1fr 1fr;gap:14px; }
      @media (max-width:680px){ #crypto-root .cw-hist { grid-template-columns:1fr; } }
      #crypto-root .cw-table { width:100%;border-collapse:collapse;font-size:12px; }
      #crypto-root .cw-table td { padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.05); }
      #crypto-root .cw-empty { color:var(--dim); }
      #crypto-root .cw-badge { padding:1px 7px;border-radius:3px;font-size:10px;letter-spacing:1px;text-transform:uppercase; }
      #crypto-root .cw-b-pending,.cw-b-pending_review,.cw-b-broadcasted,.cw-b-approved { background:rgba(255,206,74,.15);color:#ffce4a; }
      #crypto-root .cw-b-confirmed { background:rgba(127,217,122,.15);color:#7fd97a; }
      #crypto-root .cw-b-rejected,.cw-b-failed { background:rgba(255,128,128,.15);color:#ff8080; }
    `;
    document.head.appendChild(s);
  }

  // ── Wallet connect / chain / link ────────────────────────────────────────
  function depStatus(t, k) { setStatus('cw-dep-status', t, k); }
  function wdStatus(t, k)  { setStatus('cw-wd-status', t, k); }
  function setStatus(id, t, k) { const el = $('#' + id); if (el) { el.className = 'cw-status ' + (k || ''); el.textContent = t || ''; } }

  async function connect() {
    if (!window.ethereum) { depStatus('No EVM wallet found. Install MetaMask or Coinbase Wallet.', 'err'); return; }
    try {
      provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      await ensureChain();
      signer = await provider.getSigner();
      account = await signer.getAddress();
      $('#cw-account').textContent = short(account) + ' connected';
      $('#cw-link-row').style.display = '';
      $('#cw-deposit').disabled = false;
      await refreshLinkedHint();
    } catch (e) {
      depStatus(e?.info?.error?.message || e.message || 'Connect failed.', 'err');
    }
  }

  async function ensureChain() {
    const want = '0x' + Number(cfg.chainId).toString(16);
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    if (cur === want) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      // 4902 = chain not added to the wallet.
      if (e.code === 4902) {
        const params = cfg.chainId === 8453
          ? { chainId: want, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }
          : { chainId: want, chainName: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] };
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [params] });
      } else { throw e; }
    }
  }

  async function refreshLinkedHint() {
    try {
      const { wallets } = await api('/api/crypto/wallets');
      const linked = (wallets || []).some(w => account && w.address.toLowerCase() === account.toLowerCase() && w.verified_at);
      $('#cw-linked').textContent = linked ? '✓ linked' : '';
    } catch (_) {}
  }

  // Core link routine — returns true on success. Reused by the Link button
  // and auto-invoked by deposit() so users don't need a separate step.
  async function doLink() {
    if (!signer || !account) { depStatus('Connect a wallet first.', 'err'); return false; }
    const { message, nonce } = await api('/api/crypto/link-wallet/nonce', { method: 'POST', body: { address: account } });
    const signature = await signer.signMessage(message);
    await api('/api/crypto/link-wallet/verify', { method: 'POST', body: { address: account, signature, nonce } });
    $('#cw-linked').textContent = '✓ linked';
    return true;
  }

  async function isLinked() {
    try {
      const { wallets } = await api('/api/crypto/wallets');
      return (wallets || []).some(w => account && w.address.toLowerCase() === account.toLowerCase() && w.verified_at);
    } catch (_) { return false; }
  }

  async function linkWallet() {
    try {
      $('#cw-link').disabled = true;
      await doLink();
      depStatus('Wallet linked.', 'ok');
    } catch (e) {
      depStatus(friendly(e.message) || 'Link failed.', 'err');
    } finally { $('#cw-link').disabled = false; }
  }

  // ── Deposit ──────────────────────────────────────────────────────────────
  async function deposit() {
    if (!signer || !account) { depStatus('Connect a wallet first.', 'err'); return; }
    const amt = Number($('#cw-dep-amt').value);
    if (!Number.isFinite(amt) || amt < cfg.minDepositUsdc) { depStatus(`Minimum deposit is ${cfg.minDepositUsdc} USDC.`, 'err'); return; }
    const btn = $('#cw-deposit'); btn.disabled = true;
    try {
      await ensureChain();
      // Auto-link the wallet if it isn't linked yet — one fewer manual step.
      if (!(await isLinked())) {
        depStatus('First time: sign the message to link this wallet…', 'wait');
        await doLink();
      }

      depStatus('Confirm the USDC transfer in your wallet…', 'wait');
      const erc20 = new ethers.Contract(cfg.usdcContractAddress,
        ['function transfer(address to, uint256 amount) returns (bool)'], signer);
      const units = ethers.parseUnits(String(amt), cfg.usdcDecimals);
      const tx = await erc20.transfer(cfg.treasuryAddress, units);
      const txHash = tx.hash;
      depStatus('Transaction sent. Verifying on-chain…', 'wait');

      // Submit the captured hash; the backend verifies + credits.
      let r = await api('/api/crypto/deposits/submit', { method: 'POST', body: { txHash, fromAddress: account } });
      // Poll refresh until confirmed / rejected.
      let tries = 0;
      while (r.status === 'pending' && tries < 40) {
        await sleep(5000); tries++;
        depStatus(`Waiting for confirmations… (${tries})`, 'wait');
        try { r = await api('/api/crypto/deposits/refresh', { method: 'POST', body: { depositId: r.deposit.id } }); }
        catch (e) { /* transient — keep polling */ }
      }
      if (r.status === 'confirmed') {
        depStatus(`Confirmed — +${fmt(r.deposit.credits_amount)} credits added.`, 'ok');
        if (typeof r.balance === 'number') setBalance(r.balance);
      } else if (r.status === 'rejected') {
        depStatus('Rejected: ' + esc(r.reason || 'invalid deposit'), 'err');
      } else {
        depStatus('Still pending. Check the Deposits table and refresh later.', 'wait');
      }
      refreshAll();
    } catch (e) {
      depStatus(friendly(e.message) || (e?.shortMessage) || e.message || 'Deposit failed.', 'err');
    } finally { btn.disabled = false; }
  }

  // ── Withdraw ─────────────────────────────────────────────────────────────
  async function withdraw() {
    const amt = Number($('#cw-wd-amt').value);
    const addr = $('#cw-wd-addr').value.trim();
    if (!Number.isFinite(amt) || amt < cfg.minWithdrawUsdc) { wdStatus(`Minimum withdrawal is ${cfg.minWithdrawUsdc} USDC.`, 'err'); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { wdStatus('Enter a valid 0x address.', 'err'); return; }
    const btn = $('#cw-withdraw'); btn.disabled = true;
    try {
      const r = await api('/api/crypto/withdrawals/request', { method: 'POST', body: { toAddress: addr, amountUsdc: amt } });
      wdStatus(`Requested — pending admin review. Held ${fmt(r.withdrawal.credits_amount)} credits.`, 'ok');
      if (typeof r.balance === 'number') setBalance(r.balance);
      refreshAll();
    } catch (e) {
      wdStatus(friendly(e.message) || 'Withdrawal failed.', 'err');
    } finally { btn.disabled = false; }
  }

  // ── History tables ───────────────────────────────────────────────────────
  async function refreshAll() {
    try {
      const { deposits } = await api('/api/crypto/deposits');
      $('#cw-deposits').querySelector('tbody').innerHTML = (deposits && deposits.length)
        ? deposits.map(d => `<tr>
            <td>${fmt(d.amount_usdc)} USDC</td>
            <td>+${fmt(d.credits_amount)} cr</td>
            <td><span class="cw-badge cw-b-${esc(d.status)}">${esc(d.status)}</span></td>
          </tr>`).join('')
        : '<tr><td class="cw-empty">None yet.</td></tr>';
    } catch (_) {}
    try {
      const { withdrawals } = await api('/api/crypto/withdrawals');
      $('#cw-withdrawals').querySelector('tbody').innerHTML = (withdrawals && withdrawals.length)
        ? withdrawals.map(w => `<tr>
            <td>${fmt(w.amount_usdc)} USDC</td>
            <td>-${fmt(w.credits_amount)} cr</td>
            <td><span class="cw-badge cw-b-${esc(w.status)}">${esc(w.status.replace('_', ' '))}</span></td>
          </tr>`).join('')
        : '<tr><td class="cw-empty">None yet.</td></tr>';
    } catch (_) {}
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function setBalance(b) {
    const el = document.getElementById('bal'); if (el) el.textContent = fmtCredits(b);
    const tb = document.querySelector('.topbar .balance'); if (tb) tb.textContent = fmtCredits(b);
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function friendly(code) {
    return ({
      wallet_not_linked: 'Link your wallet first (sign the message).',
      tx_already_used: 'That transaction was already used.',
      below_min_withdraw: 'Below the minimum withdrawal.',
      insufficient_balance: 'Not enough credits.',
      invalid_address: 'Invalid wallet address.',
      address_linked_to_another_account: 'That address is linked to another account.',
      signature_mismatch: 'Signature did not match the address.',
      crypto_disabled: 'Crypto is disabled.',
    })[code] || null;
  }

  function wire() {
    $('#cw-connect').addEventListener('click', connect);
    $('#cw-link').addEventListener('click', linkWallet);
    $('#cw-deposit').addEventListener('click', deposit);
    $('#cw-withdraw').addEventListener('click', withdraw);
    $('#cw-dep-amt').addEventListener('input', e => {
      const c = Math.floor((Number(e.target.value) || 0) * cfg.usdcToCreditsRate);
      $('#cw-dep-conv').textContent = '= ' + fmt(c) + ' credits';
    });
    $('#cw-wd-amt').addEventListener('input', e => {
      const c = Math.round((Number(e.target.value) || 0) * cfg.usdcToCreditsRate);
      $('#cw-wd-conv').textContent = 'costs ' + fmt(c) + ' credits';
    });
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged', () => location.reload());
    }
  }

  start();
})();
