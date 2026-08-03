-- Job Copilot schema. Idempotent: safe to run on every boot.
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

CREATE INDEX IF NOT EXISTS scores_user_score_idx    ON scores (user_id, score DESC);
CREATE INDEX IF NOT EXISTS job_meta_user_status_idx ON job_meta (user_id, status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx      ON jobs (created_at DESC);
