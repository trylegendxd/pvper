-- ============================================================================
--  Blackjack — share ONE dealer across all hands in a round.
--  Previously every started hand had its own deck/dealer, which meant a
--  multi-hand deal gave each hand a separate dealer. This migration
--  introduces a `blackjack_rounds` table that holds the shared deck +
--  dealer state, and adds round_id to blackjack_hands.
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── Shared per-round state (one row per multi-hand deal) ───────────────────
CREATE TABLE IF NOT EXISTS blackjack_rounds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck          JSONB NOT NULL,                        -- remaining cards in the shoe
  dealer_cards  JSONB NOT NULL DEFAULT '[]'::jsonb,    -- shared dealer hand
  dealer_played BOOLEAN NOT NULL DEFAULT FALSE,        -- has dealer drawn to 17 yet?
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bjr_user ON blackjack_rounds (user_id, created_at DESC);

-- ── Hands now reference a round ────────────────────────────────────────────
-- We don't drop the legacy `deck` / `dealer_cards` columns from
-- blackjack_hands so existing rows + any old client code keep working.
-- New code reads dealer state via round_id; legacy single-hand starts
-- create a 1-hand round implicitly.
ALTER TABLE blackjack_hands
  ADD COLUMN IF NOT EXISTS round_id UUID REFERENCES blackjack_rounds(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bjh_round ON blackjack_hands (round_id);
