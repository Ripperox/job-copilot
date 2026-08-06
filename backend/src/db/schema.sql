-- Shortlist schema. Idempotent: safe to run on every boot.
-- Shared tables hold data identical for all users; per-user tables are keyed by user_id.

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub TEXT UNIQUE,
  email      TEXT,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared: one job pool for everyone, filled by the central scheduler.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  company     TEXT NOT NULL,
  location    TEXT NOT NULL,
  description TEXT NOT NULL,
  url         TEXT NOT NULL,
  salary      TEXT,
  posted_at   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  resume_text      TEXT NOT NULL DEFAULT '',
  roles            TEXT[] NOT NULL DEFAULT '{}',
  locations        TEXT[] NOT NULL DEFAULT '{}',
  salary_floor_lpa DOUBLE PRECISION,
  max_yoe          INTEGER,
  must_haves       TEXT[] NOT NULL DEFAULT '{}',
  cv_variants      TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS scores (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  cv_variant TEXT NOT NULL DEFAULT '',
  scored_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_meta (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status    TEXT NOT NULL DEFAULT 'new',
  notes     TEXT NOT NULL DEFAULT '',
  dismissed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE IF NOT EXISTS outreach (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  referral_message TEXT NOT NULL DEFAULT '',
  application_note TEXT NOT NULL DEFAULT '',
  targets          JSONB NOT NULL DEFAULT '[]',
  cv_variant       TEXT NOT NULL DEFAULT '',
  generated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

-- Users' own LLM API keys, encrypted at rest (AES-256-GCM). Never returned to
-- the client — the API exposes only whether a key is present, plus a mask.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gemini_key_enc      TEXT NOT NULL,
  gemini_key_mask     TEXT NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Which provider the stored key belongs to ('groq' | 'gemini' | 'anthropic').
-- Added after the table shipped, hence ALTER rather than a column above.
ALTER TABLE user_keys ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'gemini';

-- The single pre-scored example shown to visitors who have not added a key.
-- Computed once on operator keys, so cost does not scale with signups.
CREATE TABLE IF NOT EXISTS demo_score (
  job_id     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  cv_variant TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Career-page scraping state. This lived in module memory, which meant every
-- restart reset the rotation cursor to zero: the scraper re-read the same first
-- pages forever and never reached the rest of the list. Render's free tier
-- restarts often, so "in memory" effectively meant "never rotates".
CREATE TABLE IF NOT EXISTS scrape_state (
  id          INTEGER PRIMARY KEY,
  cursor      INTEGER NOT NULL DEFAULT 0,
  last_scrape TIMESTAMPTZ,
  CONSTRAINT scrape_state_single_row CHECK (id = 1)
);
INSERT INTO scrape_state (id, cursor) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Per-source health, so the app can say WHY the pool stopped growing.
--
-- Three job sources sat monthly-quota-dead for hours while the dashboard
-- happily showed a stale pool and said nothing. Errors went to stderr, which
-- nobody reads. A source that has stopped working should be visible in the
-- product, not discoverable by tailing logs.
--
-- Persisted rather than in-memory because the host restarts constantly, and a
-- health panel that forgets everything on deploy is worse than none.
CREATE TABLE IF NOT EXISTS source_health (
  name        TEXT PRIMARY KEY,
  kind        TEXT        NOT NULL,          -- job | llm | scraper
  state       TEXT        NOT NULL,          -- ok | quota | auth | error | idle
  detail      TEXT,
  items       INTEGER     NOT NULL DEFAULT 0,
  retry_after TIMESTAMPTZ,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The scrape queue: one row per target, replacing the single global cursor.
--
-- A shared cursor treated every URL identically — a JS-only shell that can
-- never yield got exactly as much of the budget as a page returning 30 roles,
-- and one global cooldown gated the whole list. Per-URL state fixes both:
-- pick the least-recently-scraped targets that are actually due, and let each
-- one earn or lose its place.
--
-- due_at is the scheduling primitive. On a successful scrape with roles it is
-- pushed out by the base interval; on an empty or failed one it backs off
-- exponentially (capped), so dead targets drift to the back of the queue
-- without ever being deleted — a company with no openings this month should
-- come back later, not be lost.
CREATE TABLE IF NOT EXISTS scrape_targets (
  url               TEXT PRIMARY KEY,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  last_scraped_at   TIMESTAMPTZ,
  due_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_roles        INTEGER     NOT NULL DEFAULT 0,
  total_roles       INTEGER     NOT NULL DEFAULT 0,
  consecutive_empty INTEGER     NOT NULL DEFAULT 0,
  last_error        TEXT
);
-- The queue read is "what is due, oldest first" — index it.
CREATE INDEX IF NOT EXISTS scrape_targets_due_idx ON scrape_targets (due_at) WHERE enabled;

CREATE INDEX IF NOT EXISTS scores_user_score_idx    ON scores (user_id, score DESC);
CREATE INDEX IF NOT EXISTS job_meta_user_status_idx ON job_meta (user_id, status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx      ON jobs (created_at DESC);
