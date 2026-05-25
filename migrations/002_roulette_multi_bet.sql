-- ============================================================================
--  002 — Multi-bet roulette support.
--  The initial schema declared roulette_spins.session_id as UNIQUE, which
--  prevented writing one row per chip when a user places several bets in the
--  same spin. Drop that constraint; the FK to game_sessions is retained.
-- ============================================================================

ALTER TABLE roulette_spins
  DROP CONSTRAINT IF EXISTS roulette_spins_session_id_key;

-- Helpful index for "all bets in this spin"
CREATE INDEX IF NOT EXISTS idx_roulette_spins_session ON roulette_spins (session_id);
