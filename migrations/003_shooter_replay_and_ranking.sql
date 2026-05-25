-- ============================================================================
--  Shooter Arena — replay/event logging + ranking/MMR
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── REPLAY / KILLCAM event log ─────────────────────────────────────────────
-- One row per finished match. The full per-match event stream is stored in
-- event_log (JSONB array); a compact aggregated view is stored in summary.
-- Writing a single row per match (not per event) keeps DB write volume sane.
CREATE TABLE IF NOT EXISTS shooter_match_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shooter_match_id   UUID NOT NULL REFERENCES shooter_sessions(id) ON DELETE CASCADE,
  session_id         UUID NOT NULL REFERENCES game_sessions(id)   ON DELETE CASCADE,
  event_log          JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary            JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspicious_count   INT   NOT NULL DEFAULT 0,
  event_count        INT   NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sme_match     ON shooter_match_events (shooter_match_id);
CREATE INDEX IF NOT EXISTS idx_sme_suspicious ON shooter_match_events (suspicious_count DESC)
  WHERE suspicious_count > 0;

-- ── RANKING / MMR / progression — one row per user, per the Shooter game ──
CREATE TABLE IF NOT EXISTS shooter_player_stats (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mmr                INT NOT NULL DEFAULT 1000,
  level              INT NOT NULL DEFAULT 1,
  xp                 INT NOT NULL DEFAULT 0,
  total_matches      INT NOT NULL DEFAULT 0,
  wins               INT NOT NULL DEFAULT 0,
  losses             INT NOT NULL DEFAULT 0,
  kills              INT NOT NULL DEFAULT 0,
  deaths             INT NOT NULL DEFAULT 0,
  headshots          INT NOT NULL DEFAULT 0,
  shots_fired        INT NOT NULL DEFAULT 0,
  shots_hit          INT NOT NULL DEFAULT 0,
  current_win_streak INT NOT NULL DEFAULT 0,
  best_win_streak    INT NOT NULL DEFAULT 0,
  last_match_at      TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sps_mmr   ON shooter_player_stats (mmr DESC);
CREATE INDEX IF NOT EXISTS idx_sps_level ON shooter_player_stats (level DESC);
