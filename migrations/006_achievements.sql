-- ============================================================================
--  Achievements — static catalog + per-user grant table.
--  Idempotent: safe to re-run.
-- ============================================================================

-- ── Catalog of achievements ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id          SERIAL PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,        -- stable lookup key
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '🏆',  -- single emoji is fine
  category    TEXT NOT NULL DEFAULT 'general',
  sort_order  INT  NOT NULL DEFAULT 0
);

-- ── Per-user grants ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id INT  NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  earned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_ua_user ON user_achievements (user_id, earned_at DESC);

-- ── Seed catalog ───────────────────────────────────────────────────────────
INSERT INTO achievements (key, name, description, icon, category, sort_order) VALUES
  -- Combat (real-time triggers in the shooter)
  ('first_kill',      'First Blood',     'Score your first kill in the shooter',         '⚔️',  'combat', 1),
  ('first_headshot',  'Headshot',        'Land your first headshot',                     '🎯',  'combat', 2),
  ('killing_spree',   'Killing Spree',   '3 kills in a row without dying',               '🔥',  'combat', 3),
  ('rampage',         'Rampage',         '5 kills in a row without dying',               '💀',  'combat', 4),
  ('wall_banger',     'Wall Banger',     'Kill an enemy through cover',                  '🧱',  'combat', 5),
  ('cold_steel',      'Cold Steel',      'Kill an enemy with the knife',                 '🔪',  'combat', 6),
  ('one_pump',        'One Pump',        'Kill an enemy with a single shotgun shot',     '💥',  'combat', 7),
  -- Match results (post-match triggers)
  ('flawless',        'Flawless',        'Win a shooter match without dying once',       '🛡️',  'match', 1),
  ('headshot_machine','Headshot Machine','Score 5 headshots in a single match',          '💀',  'match', 2),
  -- Progression (post-match level / streak / total)
  ('first_win',       'Welcome',         'Win your first shooter match',                 '🏅',  'progression', 1),
  ('streak_5',        'Hot Streak',      'Win 5 shooter matches in a row',               '🔥',  'progression', 2),
  ('streak_10',       'Untouchable',     'Win 10 shooter matches in a row',              '🌟',  'progression', 3),
  ('level_5',         'Recruit',         'Reach level 5',                                '🎖️',  'progression', 4),
  ('level_10',        'Veteran',         'Reach level 10',                               '🎖️',  'progression', 5),
  ('level_20',        'Elite',           'Reach level 20',                               '🎖️',  'progression', 6),
  ('matches_10',      'Getting Started', 'Play 10 shooter matches',                      '🎮',  'progression', 7),
  ('matches_100',     'Dedicated',       'Play 100 shooter matches',                     '🎮',  'progression', 8)
ON CONFLICT (key) DO NOTHING;
