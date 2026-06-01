// server/wallet.js — central wallet logic.
// THE ONLY place that mutates balances. Always uses a transaction.
//
// Note: we deliberately reference `db.pool` / `db.withTx` through the
// module namespace (not destructured at the top of the file). That way
// tests can swap in fake implementations by mutating the db module's
// exports, without us having to thread the db through every function
// as a parameter. See tests/wallet.test.js.
const db = require('./db');

/**
 * Adjust a user's balance. NEVER allows negative balance.
 *
 * @param {string} userId         UUID
 * @param {number} amount         positive = credit, negative = debit
 * @param {string} reason         'bet','win','refund','admin_adjust','signup_bonus',
 *                                'roulette_payout','blackjack_payout'
 * @param {object} [opts]
 * @param {string} [opts.refType] 'shooter','rps','roulette','blackjack','admin'
 * @param {string} [opts.refId]
 * @param {object} [opts.metadata]
 * @param {object} [opts.client]  existing pg client (must already be in a tx)
 * @returns {Promise<{balance:number, txId:number}>}
 */
async function adjustBalance(userId, amount, reason, opts = {}) {
  const run = async (client) => {
    // Lock the wallet row for this user
    const { rows: wrows } = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!wrows.length) throw new Error('wallet_not_found');

    const current = Number(wrows[0].balance);
    const next    = current + Number(amount);
    if (next < 0) throw new Error('insufficient_balance');

    await client.query(
      'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2',
      [next, userId]
    );

    // Ledger entry (unique index prevents duplicate payouts/refunds)
    let txRow;
    try {
      const { rows } = await client.query(
        `INSERT INTO wallet_transactions
           (user_id, amount, balance_after, reason, ref_type, ref_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [userId, amount, next, reason, opts.refType || null, opts.refId || null, opts.metadata || null]
      );
      txRow = rows[0];
    } catch (e) {
      if (e.code === '23505') {
        // Duplicate (ref_type, ref_id, reason) — payout/refund already applied
        throw new Error('duplicate_transaction');
      }
      throw e;
    }
    return { balance: next, txId: txRow.id };
  };

  if (opts.client) return run(opts.client);
  return db.withTx(run);
}

/** Get balance (read-only). */
async function getBalance(userId) {
  const { rows } = await db.pool.query(
    'SELECT balance FROM wallets WHERE user_id = $1', [userId]
  );
  return rows.length ? Number(rows[0].balance) : 0;
}

/** Recent ledger entries for a user. */
async function getHistory(userId, limit = 100) {
  const { rows } = await db.pool.query(
    `SELECT id, amount, balance_after, reason, ref_type, ref_id, metadata, created_at
       FROM wallet_transactions
      WHERE user_id = $1
   ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return rows;
}

module.exports = { adjustBalance, getBalance, getHistory };
