-- ============================================================================
--  Friends + chat
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── FRIENDSHIPS ────────────────────────────────────────────────────────────
-- One row per (user_a, user_b) pair, where user_a < user_b lexically.
-- Status:
--   'pending'  → requester_id sent an unanswered request
--   'accepted' → both users are friends
--   'blocked'  → recipient blocked the requester
CREATE TABLE IF NOT EXISTS friendships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','blocked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  CONSTRAINT friendships_canonical_pair CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships (user_a, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships (user_b, status);

-- ── CHAT MESSAGES (direct messages between users) ─────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id            BIGSERIAL PRIMARY KEY,
  from_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMPTZ
);
-- Index for "messages between A and B, newest first"
CREATE INDEX IF NOT EXISTS idx_chat_pair_created
  ON chat_messages (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_to_unread
  ON chat_messages (to_user_id, read_at)
  WHERE read_at IS NULL;
