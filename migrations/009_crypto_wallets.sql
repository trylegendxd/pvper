-- ============================================================================
--  Crypto (USDC on Base) deposits + withdrawals.
--
--  Off by default — these tables are inert unless CRYPTO_ENABLED=true and a
--  treasury wallet is configured. 1 USDC = 100 credits; USDC has 6 decimals.
--  All on-chain amounts are stored both as raw integer units (text, to avoid
--  any float rounding) and as a numeric(30,6) USDC value for display.
--  Idempotency is enforced by unique(chain, tx_hash) on every record AND by
--  the extended wallet ledger index below.
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── Linked wallets ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_crypto_wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain       TEXT NOT NULL,
  address     TEXT NOT NULL,              -- stored lowercased / checksum-normalised by the app
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, address),               -- one address can belong to one account
  UNIQUE (user_id, chain, address)
);
CREATE INDEX IF NOT EXISTS idx_user_crypto_wallets_user ON user_crypto_wallets (user_id);

-- ── Deposits ────────────────────────────────────────────────────────────────
-- status: pending | confirmed | rejected
CREATE TABLE IF NOT EXISTS crypto_deposits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  chain          TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  token_address  TEXT NOT NULL,
  amount_units   TEXT NOT NULL,           -- raw USDC base units (6 decimals) as a string
  amount_usdc    NUMERIC(30,6) NOT NULL,
  credits_amount INTEGER NOT NULL,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  reject_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at   TIMESTAMPTZ,
  UNIQUE (chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_crypto_deposits_user ON crypto_deposits (user_id, created_at DESC);

-- ── Withdrawals ─────────────────────────────────────────────────────────────
-- status: pending_review | approved | broadcasted | confirmed | rejected | failed
CREATE TABLE IF NOT EXISTS crypto_withdrawals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  chain          TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  token_address  TEXT NOT NULL,
  amount_units   TEXT NOT NULL,
  amount_usdc    NUMERIC(30,6) NOT NULL,
  credits_amount INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_review',
  tx_hash        TEXT,
  admin_note     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at    TIMESTAMPTZ,
  broadcasted_at TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  rejected_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_crypto_withdrawals_user   ON crypto_withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_withdrawals_status ON crypto_withdrawals (status, created_at DESC);
-- A broadcast tx hash is unique per chain (NULL while pending review).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crypto_withdrawal_tx
  ON crypto_withdrawals (chain, tx_hash) WHERE tx_hash IS NOT NULL;

-- ── Extend the wallet ledger idempotency index to cover crypto reasons ──────
-- so a deposit credit / withdrawal hold / refund can never be double-applied
-- for the same (ref_type, ref_id, reason).
DROP INDEX IF EXISTS uniq_wt_ref_reason;
CREATE UNIQUE INDEX uniq_wt_ref_reason
  ON wallet_transactions (ref_type, ref_id, reason)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
    AND reason IN ('win','refund','bet','blackjack_payout','roulette_payout',
                   'mines_payout','wheel_payout',
                   'crypto_deposit','crypto_withdrawal_hold','crypto_withdrawal_refund');
