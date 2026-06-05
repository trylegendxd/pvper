// server/routes/cryptoRoutes.js
// ============================================================================
//  USDC deposit / withdrawal REST API. Two routers are exported:
//    router      → mounted at /api/crypto        (logged-in users)
//    adminRouter → mounted at /api/admin/crypto  (admins only)
//
//  All balance changes go through the existing wallet ledger (adjustBalance)
//  with crypto-specific reasons, and every credit/hold/refund is idempotent
//  via the (ref_type, ref_id, reason) unique index. Deposits are credited
//  only after on-chain verification; withdrawals hold credits up front and
//  refund them on rejection/failure.
// ============================================================================
const express     = require('express');
const crypto      = require('crypto');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pool, withTx } = require('../db');
const { adjustBalance, getBalance } = require('../wallet');
const usdc = require('../crypto/baseUsdc');

const router      = express.Router();
const adminRouter = express.Router();

// ── Link-wallet nonces (in-memory, short-lived) ─────────────────────────────
// Keyed by `${userId}:${addressLower}`. Single-instance is fine for this app;
// a multi-instance deployment would move this to the DB / a shared store.
const nonces = new Map();
const NONCE_TTL_MS = 10 * 60 * 1000;
function makeNonce() { return crypto.randomBytes(16).toString('hex'); }
function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expiresAt < now) nonces.delete(k);
}

// Block everything (except GET /config) when crypto is disabled.
function requireEnabled(req, res, next) {
  if (!usdc.getCryptoConfig().enabled) return res.status(403).json({ error: 'crypto_disabled' });
  next();
}

// ── Public config ───────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  const c = usdc.getCryptoConfig();
  res.json({
    enabled:             c.enabled,
    network:             c.network,
    chainId:             c.chainId,
    usdcContractAddress: c.usdcContractAddress,
    treasuryAddress:     c.treasuryAddress || null,
    usdcDecimals:        c.usdcDecimals,
    usdcToCreditsRate:   c.usdcToCreditsRate,
    minDepositUsdc:      c.minDepositUsdc,
    minWithdrawUsdc:     c.minWithdrawUsdc,
  });
});

// Everything below requires auth + the feature enabled.
router.use(requireAuth, requireEnabled);

// ── Link wallet: request a nonce to sign ────────────────────────────────────
router.post('/link-wallet/nonce', (req, res) => {
  try {
    const address = String(req.body?.address || '');
    if (!usdc.isValidAddress(address)) return res.status(400).json({ error: 'invalid_address' });
    const addr = usdc.normalizeAddress(address);
    const userId = req.session.userId;
    const nonce = makeNonce();
    const message = `Link wallet ${addr} to Pvper account ${userId}. Nonce: ${nonce}`;
    pruneNonces();
    nonces.set(`${userId}:${addr.toLowerCase()}`, { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS });
    res.json({ ok: true, message, nonce, address: addr });
  } catch (e) {
    res.status(400).json({ error: e.message || 'nonce_failed' });
  }
});

// ── Link wallet: verify the signature ───────────────────────────────────────
router.post('/link-wallet/verify', async (req, res) => {
  try {
    const { ethers } = require('ethers');
    const address   = String(req.body?.address || '');
    const signature = String(req.body?.signature || '');
    const nonce     = String(req.body?.nonce || '');
    if (!usdc.isValidAddress(address)) return res.status(400).json({ error: 'invalid_address' });
    const addr = usdc.normalizeAddress(address);
    const userId = req.session.userId;
    const key = `${userId}:${addr.toLowerCase()}`;
    const entry = nonces.get(key);
    if (!entry || entry.nonce !== nonce || entry.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'invalid_or_expired_nonce' });
    }
    // Recover the signer and require it to match the claimed address.
    let recovered;
    try { recovered = ethers.verifyMessage(entry.message, signature); }
    catch (_) { return res.status(400).json({ error: 'bad_signature' }); }
    if (usdc.normalizeAddress(recovered) !== addr) {
      return res.status(400).json({ error: 'signature_mismatch' });
    }
    nonces.delete(key); // consume — no reuse

    const chain = usdc.getCryptoConfig().network;
    // Upsert as verified. The unique(chain, address) blocks the same address
    // being linked to two accounts.
    try {
      await pool.query(
        `INSERT INTO user_crypto_wallets (user_id, chain, address, verified_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, chain, address)
         DO UPDATE SET verified_at = NOW()`,
        [userId, chain, addr]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'address_linked_to_another_account' });
      throw e;
    }
    res.json({ ok: true, address: addr, chain });
  } catch (e) {
    res.status(400).json({ error: e.message || 'verify_failed' });
  }
});

router.get('/wallets', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT chain, address, verified_at, created_at
       FROM user_crypto_wallets WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.session.userId]
  );
  res.json({ wallets: rows });
});

// ── Deposit helpers ─────────────────────────────────────────────────────────
async function isAddressLinked(userId, chain, address) {
  const { rows } = await pool.query(
    `SELECT 1 FROM user_crypto_wallets
      WHERE user_id = $1 AND chain = $2 AND lower(address) = lower($3) AND verified_at IS NOT NULL`,
    [userId, chain, address]
  );
  return rows.length > 0;
}

// Insert (or leave) the deposit row, then return it. Used for pending/rejected
// states where we don't credit anything.
async function recordDepositState(userId, v, status, rejectReason) {
  await pool.query(
    `INSERT INTO crypto_deposits
       (user_id, chain, tx_hash, from_address, to_address, token_address,
        amount_units, amount_usdc, credits_amount, confirmations, status, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (chain, tx_hash) DO UPDATE
       SET confirmations = EXCLUDED.confirmations,
           status = CASE WHEN crypto_deposits.status = 'confirmed'
                         THEN crypto_deposits.status ELSE EXCLUDED.status END,
           reject_reason = EXCLUDED.reject_reason`,
    [userId, v.chain, v.txHash, v.fromAddress, v.toAddress, v.tokenAddress,
     v.amountUnits, v.amountUsdc, v.creditsAmount, v.confirmations || 0, status, rejectReason || null]
  );
  const { rows } = await pool.query(
    `SELECT * FROM crypto_deposits WHERE chain = $1 AND tx_hash = $2`, [v.chain, v.txHash]
  );
  return rows[0];
}

// Credit a confirmed deposit exactly once (inside a DB transaction).
async function creditConfirmedDeposit(userId, v) {
  return withTx(async (client) => {
    // Ensure the row exists, then lock it.
    await client.query(
      `INSERT INTO crypto_deposits
         (user_id, chain, tx_hash, from_address, to_address, token_address,
          amount_units, amount_usdc, credits_amount, confirmations, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       ON CONFLICT (chain, tx_hash) DO NOTHING`,
      [userId, v.chain, v.txHash, v.fromAddress, v.toAddress, v.tokenAddress,
       v.amountUnits, v.amountUsdc, v.creditsAmount, v.confirmations || 0]
    );
    const { rows } = await client.query(
      `SELECT * FROM crypto_deposits WHERE chain = $1 AND tx_hash = $2 FOR UPDATE`,
      [v.chain, v.txHash]
    );
    const dep = rows[0];
    if (dep.status === 'confirmed') {
      return { deposit: dep, balance: await getBalance(userId), credited: false };
    }
    // IMPORTANT: credit the amount from the FRESH on-chain verification
    // (v.creditsAmount), NOT dep.credits_amount. The row may have been
    // created during the pre-mine "pending" phase with amount 0 (no receipt
    // yet), so reading it back would credit 0. We also overwrite the stored
    // amounts with the verified values when confirming. The ledger unique
    // index keeps this idempotent even if two requests race through here.
    const creditsAmount = Number(v.creditsAmount) || 0;
    if (creditsAmount <= 0) throw new Error('zero_credit_amount');
    let balance;
    try {
      const r = await adjustBalance(userId, creditsAmount, 'crypto_deposit', {
        refType: 'crypto', refId: `${v.chain}:${v.txHash}`, client,
        metadata: { tx_hash: v.txHash, amount_usdc: v.amountUsdc },
      });
      balance = r.balance;
    } catch (e) {
      if (e.message !== 'duplicate_transaction') throw e;
      balance = await getBalance(userId);
    }
    const { rows: upd } = await client.query(
      `UPDATE crypto_deposits
          SET status = 'confirmed', confirmations = $1, confirmed_at = NOW(),
              amount_units = $2, amount_usdc = $3, credits_amount = $4
        WHERE id = $5 RETURNING *`,
      [v.confirmations || 0, v.amountUnits, v.amountUsdc, creditsAmount, dep.id]
    );
    return { deposit: upd[0], balance, credited: true };
  });
}

// ── Deposit: submit a tx hash ───────────────────────────────────────────────
router.post('/deposits/submit', async (req, res) => {
  try {
    const cfg = usdc.getCryptoConfig();
    const txHash = String(req.body?.txHash || '').trim();
    const fromAddress = String(req.body?.fromAddress || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'invalid_tx_hash' });
    if (!usdc.isValidAddress(fromAddress)) return res.status(400).json({ error: 'invalid_address' });
    const from = usdc.normalizeAddress(fromAddress);
    const userId = req.session.userId;

    if (!(await isAddressLinked(userId, cfg.network, from))) {
      return res.status(403).json({ error: 'wallet_not_linked' });
    }
    // Already credited?
    const { rows: ex } = await pool.query(
      `SELECT * FROM crypto_deposits WHERE chain = $1 AND tx_hash = $2`, [cfg.network, txHash]
    );
    if (ex.length && ex[0].status === 'confirmed') {
      // Don't leak another user's deposit, but a confirmed self-deposit is fine.
      if (ex[0].user_id !== userId) return res.status(409).json({ error: 'tx_already_used' });
      return res.json({ status: 'confirmed', alreadyCredited: true, deposit: ex[0] });
    }
    if (ex.length && ex[0].user_id !== userId) {
      return res.status(409).json({ error: 'tx_already_used' });
    }

    const v = await usdc.verifyUsdcDepositTx(txHash, from);
    if (v.status === 'error')    return res.status(503).json({ status: 'error', reason: v.reason });
    if (v.status === 'rejected') {
      const dep = await recordDepositState(userId, { chain: cfg.network, txHash, fromAddress: from,
        toAddress: cfg.treasuryAddress, tokenAddress: cfg.usdcContractAddress,
        amountUnits: v.amountUnits || '0', amountUsdc: v.amountUsdc || 0, creditsAmount: v.creditsAmount || 0,
        confirmations: v.confirmations || 0 }, 'rejected', v.reason);
      return res.status(400).json({ status: 'rejected', reason: v.reason, deposit: dep });
    }
    if (v.status === 'pending') {
      const dep = await recordDepositState(userId, {
        chain: cfg.network, txHash, fromAddress: from,
        toAddress: v.toAddress || cfg.treasuryAddress, tokenAddress: v.tokenAddress || cfg.usdcContractAddress,
        amountUnits: v.amountUnits || '0', amountUsdc: v.amountUsdc || 0, creditsAmount: v.creditsAmount || 0,
        confirmations: v.confirmations || 0,
      }, 'pending');
      return res.json({ status: 'pending', deposit: dep });
    }
    // confirmed
    const out = await creditConfirmedDeposit(userId, { ...v, txHash, chain: cfg.network });
    return res.json({ status: 'confirmed', creditsAdded: out.credited ? out.deposit.credits_amount : 0,
                      balance: out.balance, deposit: out.deposit });
  } catch (e) {
    res.status(400).json({ error: e.message || 'submit_failed' });
  }
});

// ── Deposit: re-check a pending deposit ─────────────────────────────────────
router.post('/deposits/refresh', async (req, res) => {
  try {
    const cfg = usdc.getCryptoConfig();
    const depositId = String(req.body?.depositId || '');
    const userId = req.session.userId;
    const { rows } = await pool.query(
      `SELECT * FROM crypto_deposits WHERE id = $1 AND user_id = $2`, [depositId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'deposit_not_found' });
    const dep = rows[0];
    if (dep.status === 'confirmed') {
      return res.json({ status: 'confirmed', deposit: dep, balance: await getBalance(userId) });
    }
    if (dep.status === 'rejected') return res.json({ status: 'rejected', deposit: dep });

    const v = await usdc.verifyUsdcDepositTx(dep.tx_hash, dep.from_address);
    if (v.status === 'error')    return res.status(503).json({ status: 'error', reason: v.reason });
    if (v.status === 'rejected') {
      await pool.query(`UPDATE crypto_deposits SET status='rejected', reject_reason=$1 WHERE id=$2`,
        [v.reason, dep.id]);
      return res.status(400).json({ status: 'rejected', reason: v.reason });
    }
    if (v.status === 'pending') {
      // Once the tx has a receipt, verify carries the real amounts — fill
      // them in so the pending row no longer shows 0 USDC.
      if (v.amountUnits) {
        await pool.query(
          `UPDATE crypto_deposits SET confirmations=$1, amount_units=$2, amount_usdc=$3, credits_amount=$4 WHERE id=$5`,
          [v.confirmations || 0, v.amountUnits, v.amountUsdc, Number(v.creditsAmount) || 0, dep.id]);
      } else {
        await pool.query(`UPDATE crypto_deposits SET confirmations=$1 WHERE id=$2`,
          [v.confirmations || 0, dep.id]);
      }
      return res.json({ status: 'pending', confirmations: v.confirmations || 0, deposit: { ...dep, confirmations: v.confirmations || 0 } });
    }
    const out = await creditConfirmedDeposit(userId, { ...v, txHash: dep.tx_hash, chain: cfg.network });
    return res.json({ status: 'confirmed', creditsAdded: out.credited ? out.deposit.credits_amount : 0,
                      balance: out.balance, deposit: out.deposit });
  } catch (e) {
    res.status(400).json({ error: e.message || 'refresh_failed' });
  }
});

router.get('/deposits', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM crypto_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.session.userId]
  );
  res.json({ deposits: rows });
});

// ── Withdrawals: request ────────────────────────────────────────────────────
router.post('/withdrawals/request', async (req, res) => {
  try {
    const cfg = usdc.getCryptoConfig();
    const toAddress = String(req.body?.toAddress || '').trim();
    const amountUsdc = Number(req.body?.amountUsdc);
    if (!usdc.isValidAddress(toAddress)) return res.status(400).json({ error: 'invalid_address' });
    if (!Number.isFinite(amountUsdc) || amountUsdc < cfg.minWithdrawUsdc) {
      return res.status(400).json({ error: 'below_min_withdraw', min: cfg.minWithdrawUsdc });
    }
    const to = usdc.normalizeAddress(toAddress);
    const credits = usdc.usdcToCredits(amountUsdc);
    if (!Number.isInteger(credits) || credits <= 0) return res.status(400).json({ error: 'invalid_amount' });
    const amountUnits = usdc.usdcDecimalToUnits(amountUsdc).toString();
    const userId = req.session.userId;

    const result = await withTx(async (client) => {
      // Create the request first so we have an id to key the ledger hold on.
      const { rows: wr } = await client.query(
        `INSERT INTO crypto_withdrawals
           (user_id, chain, to_address, token_address, amount_units, amount_usdc, credits_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review') RETURNING *`,
        [userId, cfg.network, to, cfg.usdcContractAddress, amountUnits, amountUsdc, credits]
      );
      const w = wr[0];
      // Hold (debit) the credits. Throws insufficient_balance → tx rolls back.
      await adjustBalance(userId, -credits, 'crypto_withdrawal_hold', {
        refType: 'crypto', refId: w.id, client,
        metadata: { withdrawal_id: w.id, amount_usdc: amountUsdc, to_address: to },
      });
      return w;
    });
    res.json({ ok: true, withdrawal: result, balance: await getBalance(userId) });
  } catch (e) {
    if (e.message === 'insufficient_balance') return res.status(400).json({ error: 'insufficient_balance' });
    res.status(400).json({ error: e.message || 'withdraw_failed' });
  }
});

router.get('/withdrawals', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM crypto_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.session.userId]
  );
  res.json({ withdrawals: rows });
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTER  (/api/admin/crypto)
// ════════════════════════════════════════════════════════════════════════════
adminRouter.use(requireAdmin);

adminRouter.get('/withdrawals', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.*, u.username
       FROM crypto_withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status IN ('pending_review','approved','broadcasted')
   ORDER BY w.created_at ASC`
  );
  res.json({ withdrawals: rows });
});

// Reject a pending_review withdrawal — refund the held credits.
adminRouter.post('/withdrawals/:id/reject', async (req, res) => {
  try {
    const id = req.params.id;
    const note = String(req.body?.note || '').slice(0, 500);
    const out = await withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM crypto_withdrawals WHERE id = $1 FOR UPDATE`, [id]
      );
      if (!rows.length) throw new Error('not_found');
      const w = rows[0];
      if (w.status !== 'pending_review') throw new Error('not_rejectable');
      // Refund the held credits (idempotent on the ledger index).
      try {
        await adjustBalance(w.user_id, w.credits_amount, 'crypto_withdrawal_refund', {
          refType: 'crypto', refId: w.id, client, metadata: { withdrawal_id: w.id, reason: 'rejected' },
        });
      } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
      const { rows: upd } = await client.query(
        `UPDATE crypto_withdrawals SET status='rejected', rejected_at=NOW(), admin_note=$1 WHERE id=$2 RETURNING *`,
        [note, id]
      );
      return upd[0];
    });
    res.json({ ok: true, withdrawal: out });
  } catch (e) {
    const code = ({ not_found: 404, not_rejectable: 409 })[e.message] || 400;
    res.status(code).json({ error: e.message || 'reject_failed' });
  }
});

// Approve + broadcast a pending_review withdrawal.
adminRouter.post('/withdrawals/:id/approve', async (req, res) => {
  try {
    const cfg = usdc.getCryptoConfig();
    if (!cfg.enabled) return res.status(403).json({ error: 'crypto_disabled' });
    const id = req.params.id;
    // Move to 'approved' atomically so two admins can't both broadcast.
    const claim = await withTx(async (client) => {
      const { rows } = await client.query(`SELECT * FROM crypto_withdrawals WHERE id=$1 FOR UPDATE`, [id]);
      if (!rows.length) throw new Error('not_found');
      const w = rows[0];
      if (w.status !== 'pending_review') throw new Error('not_approvable');
      await client.query(`UPDATE crypto_withdrawals SET status='approved', approved_at=NOW() WHERE id=$1`, [id]);
      return w;
    });

    // Broadcast the USDC transfer from the treasury (server-only key).
    let txHash;
    try {
      const r = await usdc.broadcastUsdcWithdrawal(claim.to_address, claim.amount_units);
      txHash = r.txHash;
    } catch (e) {
      // Couldn't even submit — roll back to pending_review so it can be retried.
      await pool.query(`UPDATE crypto_withdrawals SET status='pending_review', approved_at=NULL WHERE id=$1`, [id]);
      return res.status(502).json({ error: 'broadcast_failed', detail: e.message });
    }
    const { rows: upd } = await pool.query(
      `UPDATE crypto_withdrawals SET status='broadcasted', tx_hash=$1, broadcasted_at=NOW() WHERE id=$2 RETURNING *`,
      [txHash, id]
    );
    res.json({ ok: true, withdrawal: upd[0] });
  } catch (e) {
    const code = ({ not_found: 404, not_approvable: 409 })[e.message] || 400;
    res.status(code).json({ error: e.message || 'approve_failed' });
  }
});

// Refresh a broadcasted withdrawal's confirmations; confirm or fail+refund.
adminRouter.post('/withdrawals/:id/refresh', async (req, res) => {
  try {
    const cfg = usdc.getCryptoConfig();
    const id = req.params.id;
    const { rows } = await pool.query(`SELECT * FROM crypto_withdrawals WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const w = rows[0];
    if (w.status !== 'broadcasted' || !w.tx_hash) {
      return res.json({ ok: true, status: w.status, withdrawal: w });
    }
    const info = await usdc.getTxConfirmations(w.tx_hash);
    if (info.status === 'failed') {
      // On-chain failure — mark failed and refund the held credits once.
      const out = await withTx(async (client) => {
        const { rows: lk } = await client.query(`SELECT * FROM crypto_withdrawals WHERE id=$1 FOR UPDATE`, [id]);
        const cur = lk[0];
        if (cur.status !== 'broadcasted') return cur;
        try {
          await adjustBalance(cur.user_id, cur.credits_amount, 'crypto_withdrawal_refund', {
            refType: 'crypto', refId: cur.id, client, metadata: { withdrawal_id: cur.id, reason: 'tx_failed' },
          });
        } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
        const { rows: upd } = await client.query(
          `UPDATE crypto_withdrawals SET status='failed' WHERE id=$1 RETURNING *`, [id]);
        return upd[0];
      });
      return res.json({ ok: true, status: 'failed', withdrawal: out });
    }
    if (info.status === 'success' && info.confirmations >= cfg.withdrawalConfirmations) {
      const { rows: upd } = await pool.query(
        `UPDATE crypto_withdrawals SET status='confirmed', confirmed_at=NOW() WHERE id=$1 RETURNING *`, [id]);
      return res.json({ ok: true, status: 'confirmed', withdrawal: upd[0] });
    }
    res.json({ ok: true, status: 'broadcasted', confirmations: info.confirmations, withdrawal: w });
  } catch (e) {
    res.status(400).json({ error: e.message || 'refresh_failed' });
  }
});

module.exports = { router, adminRouter };
