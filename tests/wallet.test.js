// tests/wallet.test.js
// Unit tests for the wallet — the strictest correctness boundary in the
// platform (one bad mutation can lose play-money credits). Uses Node's
// built-in test runner so no devDependencies are required.
//
//   npm test
//
// Strategy: replace db.pool and db.withTx with in-memory fakes BEFORE
// requiring server/wallet.js. wallet.js reads them through the `db`
// module namespace (not destructured) for exactly this reason.

const test   = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db');

// ── Fake pg client ─────────────────────────────────────────────────────
// Records every query for assertions and routes SQL via regex matching.
// Each test gets a fresh fakeClient via beforeEach.
function makeFakeClient(initial = { balance: 100 }) {
  const state = { ...initial };
  const queries = [];
  return {
    state,
    queries,
    released: false,
    release() { this.released = true; },
    query(sql, params) {
      queries.push({ sql, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT balance FROM wallets/.test(sql)) {
        if (state.balance === null || state.balance === undefined) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [{ balance: state.balance }] });
      }
      if (/UPDATE wallets SET balance/.test(sql)) {
        state.balance = params[0];
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO wallet_transactions/.test(sql)) {
        if (state.dupNext) {
          state.dupNext = false;
          const err = new Error('duplicate key value');
          err.code = '23505';
          return Promise.reject(err);
        }
        const id = state.nextTxId ?? 999;
        state.nextTxId = id + 1;
        return Promise.resolve({ rows: [{ id }] });
      }
      // Unknown query — succeed silently so tests don't over-couple to SQL.
      return Promise.resolve({ rows: [] });
    },
  };
}

let fakeClient;

// Swap db.pool + db.withTx BEFORE wallet.js is required, then keep them
// in sync with a fresh fakeClient per test.
function installFakes() {
  db.pool = {
    query: (sql, params) => fakeClient.query(sql, params),
    connect: async () => fakeClient,
  };
  db.withTx = async (fn) => {
    await fakeClient.query('BEGIN');
    try {
      const result = await fn(fakeClient);
      await fakeClient.query('COMMIT');
      return result;
    } catch (e) {
      try { await fakeClient.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      fakeClient.release();
    }
  };
}

// Install fakes before requiring wallet.js so its first call resolves
// the patched module functions.
fakeClient = makeFakeClient();
installFakes();
const wallet = require('../server/wallet');

test.beforeEach(() => {
  fakeClient = makeFakeClient();
  installFakes();
});

// ── Tests ──────────────────────────────────────────────────────────────

test('credits a positive amount and writes a ledger row', async () => {
  const res = await wallet.adjustBalance('u1', 50, 'win', {
    refType: 'shooter', refId: 's1',
  });
  assert.equal(res.balance, 150);
  assert.equal(res.txId, 999);
  assert.equal(fakeClient.state.balance, 150);
});

test('debits a negative amount when balance is sufficient', async () => {
  const res = await wallet.adjustBalance('u1', -40, 'bet', {
    refType: 'shooter', refId: 's2',
  });
  assert.equal(res.balance, 60);
});

test('throws insufficient_balance when next balance would be negative', async () => {
  await assert.rejects(
    wallet.adjustBalance('u1', -500, 'bet', { refType: 'shooter', refId: 's3' }),
    /insufficient_balance/,
  );
  // ROLLBACK fired because withTx caught the throw.
  const rollbacks = fakeClient.queries.filter(q => q.sql === 'ROLLBACK').length;
  assert.equal(rollbacks, 1);
  // Balance is unchanged in the fake (UPDATE never ran since SELECT then
  // throw happens before UPDATE — assert that explicitly).
  const updates = fakeClient.queries.filter(q => /UPDATE wallets/.test(q.sql));
  assert.equal(updates.length, 0);
});

test('throws wallet_not_found when no wallet row exists', async () => {
  fakeClient.state.balance = null;
  await assert.rejects(
    wallet.adjustBalance('u1', 50, 'win', { refType: 'shooter', refId: 's4' }),
    /wallet_not_found/,
  );
});

test('maps PG 23505 unique violation to duplicate_transaction', async () => {
  fakeClient.state.dupNext = true;
  await assert.rejects(
    wallet.adjustBalance('u1', 50, 'win', { refType: 'shooter', refId: 's5' }),
    /duplicate_transaction/,
  );
  // Rolled back so the UPDATE we did just before the failed INSERT
  // doesn't persist a phantom balance change.
  const rollbacks = fakeClient.queries.filter(q => q.sql === 'ROLLBACK').length;
  assert.equal(rollbacks, 1);
});

test('reuses passed client without wrapping in withTx', async () => {
  const sharedClient = makeFakeClient({ balance: 200 });
  const res = await wallet.adjustBalance('u1', 25, 'win', {
    refType: 'rps', refId: 'r1', client: sharedClient,
  });
  assert.equal(res.balance, 225);
  // No BEGIN/COMMIT on the shared client — that's the caller's job.
  const txControl = sharedClient.queries.filter(q =>
    q.sql === 'BEGIN' || q.sql === 'COMMIT' || q.sql === 'ROLLBACK'
  );
  assert.equal(txControl.length, 0);
});

test('zero amount is a valid no-op-ish credit (still writes ledger row)', async () => {
  // A zero adjust shouldn't fail; sometimes called as a defensive idempotent
  // step. Should still record a ledger row for audit.
  const res = await wallet.adjustBalance('u1', 0, 'admin_adjust', {
    refType: 'admin', refId: 'a1',
  });
  assert.equal(res.balance, 100);
  const inserts = fakeClient.queries.filter(q =>
    /INSERT INTO wallet_transactions/.test(q.sql)
  );
  assert.equal(inserts.length, 1);
});

test('getBalance returns 0 when no wallet row exists', async () => {
  fakeClient.state.balance = null;
  const bal = await wallet.getBalance('u_nobody');
  assert.equal(bal, 0);
});

test('getBalance returns the row balance as a Number', async () => {
  fakeClient.state.balance = '12345';   // pg returns BIGINT as string
  const bal = await wallet.getBalance('u1');
  assert.equal(bal, 12345);
  assert.equal(typeof bal, 'number');
});
