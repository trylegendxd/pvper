-- ============================================================================
--  User-editable profile fields: display name, avatar, bio.
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── display_name: free-form name shown on profile / topbar / killfeed.
--    Falls back to username when null. 1–32 chars when set.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 32);

-- ── avatar: base64 data URL of a small avatar image. The PATCH
--    endpoint caps the payload at ~200 KB so the row stays sensible.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar TEXT;

-- ── bio: short 280-char description.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio TEXT
    CHECK (bio IS NULL OR length(bio) <= 280);
