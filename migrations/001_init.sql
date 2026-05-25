-- ============================================================================
--  FPS Arena Platform — initial schema (PostgreSQL)
--  Idempotent: safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL CHECK (length(username) BETWEEN 3 AND 24),
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

-- ── WALLETS (one row per user) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance   BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  escrow    BIGINT NOT NULL DEFAULT 0 CHECK (escrow >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── WALLET TRANSACTIONS (immutable ledger) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       BIGINT NOT NULL,           -- positive = credit, negative = debit
  balance_after BIGINT NOT NULL,          -- snapshot for audit
  reason       TEXT NOT NULL,             -- 'bet', 'win', 'refund', 'admin_adjust', 'signup_bonus', ...
  ref_type     TEXT,                      -- 'shooter','rps','roulette','blackjack','admin'
  ref_id       TEXT,                      -- match id, spin id, hand id, ...
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wt_user_created ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wt_ref ON wallet_transactions (ref_type, ref_id);

-- Prevent duplicate payouts/refunds for the same (ref_type, ref_id, reason)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wt_ref_reason
  ON wallet_transactions (ref_type, ref_id, reason)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
    AND reason IN ('win','refund','bet','blackjack_payout','roulette_payout');

-- ── GAME SESSIONS (generic header for every match/spin/hand) ────────────────
CREATE TABLE IF NOT EXISTS game_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_type   TEXT NOT NULL,                 -- 'shooter','rps','roulette','blackjack'
  status      TEXT NOT NULL DEFAULT 'pending', -- pending,active,finished,cancelled,refunded
  bet_amount  BIGINT NOT NULL DEFAULT 0,
  pot_amount  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gs_type_status ON game_sessions (game_type, status);

-- ── SHOOTER ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shooter_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID UNIQUE NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  lobby_id      TEXT NOT NULL,
  bet_amount    BIGINT NOT NULL,
  player_a_id   UUID NOT NULL REFERENCES users(id),
  player_b_id   UUID NOT NULL REFERENCES users(id),
  winner_id     UUID REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active',   -- active,finished,cancelled,refunded
  result_reason TEXT,                              -- 'kills','timeout','forfeit','disconnect','cancelled'
  player_a_kills INT NOT NULL DEFAULT 0,
  player_b_kills INT NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ss_status ON shooter_sessions (status);

-- ── RPS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rps_matches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID UNIQUE NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  bet_amount   BIGINT NOT NULL,
  player_a_id  UUID NOT NULL REFERENCES users(id),
  player_b_id  UUID NOT NULL REFERENCES users(id),
  winner_id    UUID REFERENCES users(id),     -- NULL = draw / refund
  status       TEXT NOT NULL DEFAULT 'active',-- active,finished,cancelled,refunded
  player_a_score INT NOT NULL DEFAULT 0,
  player_b_score INT NOT NULL DEFAULT 0,
  result_reason  TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS rps_rounds (
  id           BIGSERIAL PRIMARY KEY,
  match_id     UUID NOT NULL REFERENCES rps_matches(id) ON DELETE CASCADE,
  round_no     INT NOT NULL,
  player_a_choice TEXT,    -- 'rock','paper','scissors', or NULL on timeout
  player_b_choice TEXT,
  winner_id    UUID REFERENCES users(id),     -- NULL = tie
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, round_no)
);

-- ── ROULETTE ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roulette_spins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID UNIQUE NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  bet_type    TEXT NOT NULL,    -- 'red','black','odd','even','low','high','number'
  bet_value   INT,              -- for 'number': 0..36, otherwise NULL
  bet_amount  BIGINT NOT NULL,
  result_number INT NOT NULL,
  result_color  TEXT NOT NULL,  -- 'red','black','green'
  payout      BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roulette_user ON roulette_spins (user_id, created_at DESC);

-- ── BLACKJACK ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blackjack_hands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID UNIQUE NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  bet_amount   BIGINT NOT NULL,
  deck         JSONB NOT NULL,           -- remaining deck (server only)
  player_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
  dealer_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'active', -- active,player_bust,player_blackjack,dealer_done,push,won,lost
  outcome      TEXT,                     -- 'win','lose','push','blackjack'
  payout       BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bj_user ON blackjack_hands (user_id, created_at DESC);

-- ── AUDIT LOGS (admin actions, suspicious events) ───────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID REFERENCES users(id),    -- NULL = system
  action     TEXT NOT NULL,
  target_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);

-- ── SESSION STORE (connect-pg-simple) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default",
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  PRIMARY KEY ("sid")
) WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
