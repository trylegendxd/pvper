-- 010_decimal_credits.sql
-- ============================================================================
--  Credits now support up to 2 decimal places (e.g. a 0.5× Plinko hit on a
--  3-credit bet pays 1.50, and a blackjack 3:2 pays x1.5). Every money column
--  is widened from BIGINT to NUMERIC(18,2).
--
--  This is LOSSLESS for existing data — an integer 100 becomes 100.00 — and
--  each ALTER keeps the column's existing DEFAULT / NOT NULL / CHECK rules.
--  Bets themselves are still validated to whole numbers in the game logic;
--  only payouts / balances can carry the fractional part.
-- ============================================================================

ALTER TABLE wallets
  ALTER COLUMN balance TYPE NUMERIC(18,2),
  ALTER COLUMN escrow  TYPE NUMERIC(18,2);

ALTER TABLE wallet_transactions
  ALTER COLUMN amount        TYPE NUMERIC(18,2),
  ALTER COLUMN balance_after TYPE NUMERIC(18,2);

ALTER TABLE game_sessions
  ALTER COLUMN bet_amount TYPE NUMERIC(18,2),
  ALTER COLUMN pot_amount TYPE NUMERIC(18,2);

ALTER TABLE shooter_sessions
  ALTER COLUMN bet_amount TYPE NUMERIC(18,2);

ALTER TABLE rps_matches
  ALTER COLUMN bet_amount TYPE NUMERIC(18,2);

ALTER TABLE roulette_spins
  ALTER COLUMN bet_amount TYPE NUMERIC(18,2),
  ALTER COLUMN payout     TYPE NUMERIC(18,2);

ALTER TABLE blackjack_hands
  ALTER COLUMN bet_amount TYPE NUMERIC(18,2),
  ALTER COLUMN payout     TYPE NUMERIC(18,2);

ALTER TABLE wheel_rounds
  ALTER COLUMN total_gray   TYPE NUMERIC(18,2),
  ALTER COLUMN total_pink   TYPE NUMERIC(18,2),
  ALTER COLUMN total_blue   TYPE NUMERIC(18,2),
  ALTER COLUMN total_yellow TYPE NUMERIC(18,2),
  ALTER COLUMN total_payout TYPE NUMERIC(18,2);
