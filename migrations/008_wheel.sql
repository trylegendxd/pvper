-- ============================================================================
--  Wheel — 4-colour multiplier wheel with a 20 s betting phase running
--  continuously on the server. Every spin is recorded for auditing.
--  Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wheel_rounds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID UNIQUE REFERENCES game_sessions(id) ON DELETE SET NULL,
  -- Winning segment index (0..N-1) and the colour key that segment maps to.
  winning_segment     INT  NOT NULL CHECK (winning_segment >= 0),
  winning_color       TEXT NOT NULL CHECK (winning_color IN ('gray','pink','blue','yellow')),
  -- Multiplier the winning colour paid out at, for quick historical lookups.
  winning_multiplier  INT  NOT NULL,
  -- Total bet amounts per colour for this round (server-side aggregates).
  total_gray          BIGINT NOT NULL DEFAULT 0,
  total_pink          BIGINT NOT NULL DEFAULT 0,
  total_blue          BIGINT NOT NULL DEFAULT 0,
  total_yellow        BIGINT NOT NULL DEFAULT 0,
  -- Total credits paid out across all winning bets for this round.
  total_payout        BIGINT NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spun_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wheel_rounds_started ON wheel_rounds (started_at DESC);

-- ── Extend the wallet_transactions duplicate-prevention index to cover
-- wheel payouts. Existing 'bet' coverage already protects double-debit.
-- ============================================================================

DROP INDEX IF EXISTS uniq_wt_ref_reason;
CREATE UNIQUE INDEX uniq_wt_ref_reason
  ON wallet_transactions (ref_type, ref_id, reason)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
    AND reason IN ('win','refund','bet','blackjack_payout','roulette_payout',
                   'mines_payout','wheel_payout');
