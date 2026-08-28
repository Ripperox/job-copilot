import { query, pool } from './pool';
import { Job, Profile, Score, JobMeta, Outreach, ScoredJob, salaryFloorToLPA } from '../types';
import {
  JobRow, toJob,
  ProfileRow, toProfile,
  ScoreRow, toScore,
  JobMetaRow, toMeta,
  OutreachRow, toOutreach,
} from './rows';

// The single user for Phase 1. Phase 3 replaces every call site with the
// authenticated session's user id; the schema and queries do not change.
export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

const DEFAULT_META: JobMeta = { status: 'new', notes: '', dismissed: false };

type ScoredJobRow = JobRow & {
  score: number | null;
  reason: string | null;
  cv_variant: string | null;
  status: string | null;
  notes: string | null;
  dismissed: boolean | null;
};

function toScoredJob(r: ScoredJobRow): ScoredJob {
  return {
    ...toJob(r),
    score: r.score,
    reason: r.reason,
    cvVariant: r.cv_variant,
    status: (r.status ?? DEFAULT_META.status) as ScoredJob['status'],
    notes: r.notes ?? DEFAULT_META.notes,
    dismissed: r.dismissed ?? DEFAULT_META.dismissed,
  };
}

// One round-trip for the dashboard instead of a score+meta lookup per job.
const SCORED_JOB_SELECT = `
  SELECT j.*, s.score, s.reason, s.cv_variant, m.status, m.notes, m.dismissed
  FROM jobs j
  LEFT JOIN scores   s ON s.job_id = j.id AND s.user_id = $1
  LEFT JOIN job_meta m ON m.job_id = j.id AND m.user_id = $1`;

export interface User {
  id: string;
  email: string;
  name: string;
}

interface UserRow { id: string; email: string | null; name: string | null }

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email ?? '', name: r.name ?? '' });

export const db = {
  async ensureUser(id: string, email = '', name = ''): Promise<void> {
    await query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, email, name],
    );
  },

  // ---- accounts ----

  // Find-or-create by Google's stable subject id. Email/name are refreshed on each
  // sign-in so a changed Google profile stays in sync.
  async upsertGoogleUser(googleSub: string, email: string, name: string): Promise<User> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id, email, name`,
      [googleSub, email, name],
    );
    return toUser(rows[0]);
  },

  async getUser(id: string): Promise<User | undefined> {
    const { rows } = await query<UserRow>('SELECT id, email, name FROM users WHERE id = $1', [id]);
    return rows.length ? toUser(rows[0]) : undefined;
  },

  // Removes the account and, by ON DELETE CASCADE, its profile, scores, pipeline
  // and outreach. Shared job rows are untouched.
  async deleteUser(id: string): Promise<void> {
    await query('DELETE FROM users WHERE id = $1', [id]);
  },

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await query<UserRow>(
      'SELECT id, email, name FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    return rows.length ? toUser(rows[0]) : undefined;
  },

  // Users the scheduler should fetch for — a profile is what supplies the search
  // queries, so users without one are skipped.
  async usersWithProfiles(): Promise<string[]> {
    const { rows } = await query<{ user_id: string }>('SELECT user_id FROM profiles');
    return rows.map((r) => r.user_id);
  },

  // Move every per-user row from one account to another. Used once, to hand the
  // pre-auth local data to a real Google account. Runs in a transaction so a
  // failure part-way cannot split the data across two owners.
  async transferUserData(fromUserId: string, toUserId: string): Promise<Record<string, number>> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved: Record<string, number> = {};
      // Destination rows win on conflict, so re-running is safe.
      for (const table of ['scores', 'job_meta', 'outreach'] as const) {
        const r = await client.query(
          `UPDATE ${table} SET user_id = $2 WHERE user_id = $1
           AND job_id NOT IN (SELECT job_id FROM ${table} WHERE user_id = $2)`,
          [fromUserId, toUserId],
        );
        moved[table] = r.rowCount ?? 0;
      }
      const p = await client.query(
        `UPDATE profiles SET user_id = $2 WHERE user_id = $1
         AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = $2)`,
        [fromUserId, toUserId],
      );
      moved.profiles = p.rowCount ?? 0;
      await client.query('COMMIT');
      return moved;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  // ---- jobs (shared across all users) ----

  // Returns true when the job was newly inserted, false when it already existed.
  // xmax = 0 distinguishes a real INSERT from an ON CONFLICT UPDATE.
  async upsertJob(job: Job): Promise<boolean> {
    const { rows } = await query<{ inserted: boolean }>(
      `INSERT INTO jobs (id, source, title, company, location, description, url, salary, posted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         source = EXCLUDED.source, title = EXCLUDED.title, company = EXCLUDED.company,
         location = EXCLUDED.location, description = EXCLUDED.description, url = EXCLUDED.url,
         salary = EXCLUDED.salary, posted_at = EXCLUDED.posted_at
       RETURNING (xmax = 0) AS inserted`,
      [job.id, job.source, job.title, job.company, job.location, job.description,
       job.url, job.salary, job.postedAt, job.createdAt],
    );
    return rows[0].inserted;
  },

  /**
   * Upsert many jobs in ONE statement.
   *
   * The caller used to loop `upsertJob` per job. Measured against the Neon
   * pooler a round trip is ~209ms, so the 443-job ATS import spent ~92 seconds
   * doing nothing but waiting. Batched, the same import is a couple of
   * statements. Chunked because Postgres caps a statement at 65535 parameters
   * and each job binds 10.
   *
   * Returns how many rows were newly inserted (xmax = 0), same as before.
   */
  async upsertJobs(jobs: Job[]): Promise<number> {
    if (!jobs.length) return 0;
    const COLS = 10;
    const CHUNK = 500; // 5,000 params — comfortably under the 65,535 ceiling
    let inserted = 0;

    for (let i = 0; i < jobs.length; i += CHUNK) {
      const chunk = jobs.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((job, n) => {
        values.push(job.id, job.source, job.title, job.company, job.location,
                    job.description, job.url, job.salary, job.postedAt, job.createdAt);
        const base = n * COLS;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
      });
      const { rows } = await query<{ inserted: boolean }>(
        `INSERT INTO jobs (id, source, title, company, location, description, url, salary, posted_at, created_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (id) DO UPDATE SET
           source = EXCLUDED.source, title = EXCLUDED.title, company = EXCLUDED.company,
           location = EXCLUDED.location, description = EXCLUDED.description, url = EXCLUDED.url,
           salary = EXCLUDED.salary, posted_at = EXCLUDED.posted_at
         RETURNING (xmax = 0) AS inserted`,
        values,
      );
      inserted += rows.filter((r) => r.inserted).length;
    }
    return inserted;
  },

  /** Count only. Loading every row to call .length cost 4s at 1,724 jobs. */
  async countJobs(): Promise<number> {
    const { rows } = await query<{ n: string }>('SELECT count(*)::int AS n FROM jobs');
    return Number(rows[0].n);
  },

  /** Per-source counts in SQL. Counting in JS over allJobs() cost 4s; this is ~200ms. */
  async countBySource(): Promise<{ name: string; count: number }[]> {
    const { rows } = await query<{ source: string; n: string }>(
      'SELECT source, count(*)::int AS n FROM jobs GROUP BY source ORDER BY n DESC',
    );
    return rows.map((r) => ({ name: r.source, count: Number(r.n) }));
  },

  /** One job by id. allJobs().find() pulled the whole table to find one row. */
  async getJob(id: string): Promise<Job | undefined> {
    const { rows } = await query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows.length ? toJob(rows[0]) : undefined;
  },

  async allJobs(): Promise<Job[]> {
    const { rows } = await query<JobRow>('SELECT * FROM jobs');
    return rows.map(toJob);
  },

  // ---- profile (per user) ----

  async getProfile(userId: string): Promise<Profile | null> {
    const { rows } = await query<ProfileRow>(
      `SELECT resume_text, roles, locations,
              salary_floor_lpa, salary_floor_amount, salary_currency, salary_period,
              max_yoe, must_haves, cv_variants
       FROM profiles WHERE user_id = $1`,
      [userId],
    );
    return rows.length ? toProfile(rows[0]) : null;
  },

  async setProfile(userId: string, p: Profile): Promise<Profile> {
    // The legacy LPA column is kept in sync (as lakhs) so old code and reports
    // that still read it stay correct, but the structured fields are now the
    // source of truth.
    const lpa = salaryFloorToLPA(p.salaryFloor);
    await query(
      `INSERT INTO profiles (user_id, resume_text, roles, locations, salary_floor_lpa,
                             salary_floor_amount, salary_currency, salary_period,
                             max_yoe, must_haves, cv_variants)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id) DO UPDATE SET
         resume_text = EXCLUDED.resume_text, roles = EXCLUDED.roles,
         locations = EXCLUDED.locations, salary_floor_lpa = EXCLUDED.salary_floor_lpa,
         salary_floor_amount = EXCLUDED.salary_floor_amount,
         salary_currency = EXCLUDED.salary_currency,
         salary_period = EXCLUDED.salary_period,
         max_yoe = EXCLUDED.max_yoe, must_haves = EXCLUDED.must_haves,
         cv_variants = EXCLUDED.cv_variants`,
      [userId, p.resumeText, p.roles, p.locations, lpa,
       p.salaryFloor.amount, p.salaryFloor.currency, p.salaryFloor.period,
       p.maxYoE, p.mustHaves, p.cvVariants],
    );
    return p;
  },

  // ---- scores (per user) ----

  async getScore(userId: string, jobId: string): Promise<Score | undefined> {
    const { rows } = await query<ScoreRow>(
      `SELECT job_id, score, reason, cv_variant, scored_at
       FROM scores WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId],
    );
    return rows.length ? toScore(rows[0]) : undefined;
  },

  async setScore(userId: string, s: Score): Promise<void> {
    await query(
      `INSERT INTO scores (user_id, job_id, score, reason, cv_variant, scored_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         score = EXCLUDED.score, reason = EXCLUDED.reason,
         cv_variant = EXCLUDED.cv_variant, scored_at = EXCLUDED.scored_at`,
      [userId, s.jobId, s.score, s.reason, s.cvVariant, s.scoredAt],
    );
  },

  async countScores(userId: string): Promise<number> {
    const { rows } = await query<{ n: string }>(
      'SELECT count(*)::int AS n FROM scores WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  },

  async unscoredJobs(userId: string): Promise<Job[]> {
    const { rows } = await query<JobRow>(
      `SELECT j.* FROM jobs j
       LEFT JOIN scores s ON s.job_id = j.id AND s.user_id = $1
       WHERE s.job_id IS NULL`,
      [userId],
    );
    return rows.map(toJob);
  },

  // ---- pipeline metadata (per user) ----

  async getMeta(userId: string, jobId: string): Promise<JobMeta> {
    const { rows } = await query<JobMetaRow>(
      `SELECT status, notes, dismissed FROM job_meta WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId],
    );
    return rows.length ? toMeta(rows[0]) : { ...DEFAULT_META };
  },

  // COALESCE keeps unspecified fields at their current value, so a partial patch
  // merges rather than overwrites.
  async setMeta(userId: string, jobId: string, patch: Partial<JobMeta>): Promise<JobMeta> {
    const { rows } = await query<JobMetaRow>(
      `INSERT INTO job_meta (user_id, job_id, status, notes, dismissed)
       VALUES ($1, $2, COALESCE($3, 'new'), COALESCE($4, ''), COALESCE($5, false))
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         status    = COALESCE($3, job_meta.status),
         notes     = COALESCE($4, job_meta.notes),
         dismissed = COALESCE($5, job_meta.dismissed)
       RETURNING status, notes, dismissed`,
      [userId, jobId, patch.status ?? null, patch.notes ?? null, patch.dismissed ?? null],
    );
    return toMeta(rows[0]);
  },

  // ---- outreach (per user) ----

  async getOutreach(userId: string, jobId: string): Promise<Outreach | undefined> {
    const { rows } = await query<OutreachRow>(
      `SELECT job_id, referral_message, application_note, targets, cv_variant, generated_at
       FROM outreach WHERE user_id = $1 AND job_id = $2`,
      [userId, jobId],
    );
    return rows.length ? toOutreach(rows[0]) : undefined;
  },

  async setOutreach(userId: string, o: Outreach): Promise<void> {
    await query(
      `INSERT INTO outreach (user_id, job_id, referral_message, application_note, targets, cv_variant, generated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         referral_message = EXCLUDED.referral_message,
         application_note = EXCLUDED.application_note,
         targets = EXCLUDED.targets, cv_variant = EXCLUDED.cv_variant,
         generated_at = EXCLUDED.generated_at`,
      [userId, o.jobId, o.referralMessage, o.applicationNote,
       JSON.stringify(o.targets), o.cvVariant, o.generatedAt],
    );
  },

  // ---- bring-your-own-key (encrypted at rest) ----

  async setUserKey(
    userId: string,
    encrypted: string,
    mask: string,
    provider: 'cerebras' | 'groq' | 'gemini' | 'anthropic',
  ): Promise<void> {
    await query(
      `INSERT INTO user_keys (user_id, gemini_key_enc, gemini_key_mask, provider, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         gemini_key_enc = EXCLUDED.gemini_key_enc,
         gemini_key_mask = EXCLUDED.gemini_key_mask,
         provider = EXCLUDED.provider,
         updated_at = now()`,
      [userId, encrypted, mask, provider],
    );
  },

  // Returns the still-encrypted blob; decryption happens in the caller so the
  // plaintext key exists only for the duration of one LLM call.
  async getUserKeyRecord(
    userId: string,
  ): Promise<{ encrypted: string; mask: string; provider: 'cerebras' | 'groq' | 'gemini' | 'anthropic' } | undefined> {
    const { rows } = await query<{
      gemini_key_enc: string;
      gemini_key_mask: string;
      provider: 'cerebras' | 'groq' | 'gemini' | 'anthropic';
    }>(
      'SELECT gemini_key_enc, gemini_key_mask, provider FROM user_keys WHERE user_id = $1',
      [userId],
    );
    return rows.length
      ? { encrypted: rows[0].gemini_key_enc, mask: rows[0].gemini_key_mask, provider: rows[0].provider }
      : undefined;
  },

  async deleteUserKey(userId: string): Promise<void> {
    await query('DELETE FROM user_keys WHERE user_id = $1', [userId]);
  },

  // ---- career-page scrape state ----
  // Persisted rather than held in memory: the host restarts often, and an
  // in-memory cursor reset the rotation to page 0 every time, so the tail of the
  // target list was never read at all.

  async getScrapeState(): Promise<{ cursor: number; lastScrape: number }> {
    const { rows } = await query<{ cursor: number; last_scrape: Date | null }>(
      'SELECT cursor, last_scrape FROM scrape_state WHERE id = 1',
    );
    if (!rows.length) return { cursor: 0, lastScrape: 0 };
    return {
      cursor: Number(rows[0].cursor) || 0,
      lastScrape: rows[0].last_scrape ? new Date(rows[0].last_scrape).getTime() : 0,
    };
  },

  // ---- the scrape queue ----

  /**
   * Register targets, without disturbing ones already in the queue.
   *
   * Runs on every boot so the config list is the source of truth for WHICH
   * urls exist, while the database stays the source of truth for when each was
   * last read. Removing a url from config disables rather than deletes it, so
   * its history survives if it comes back.
   */
  async syncScrapeTargets(urls: string[]): Promise<{ added: number; disabled: number }> {
    if (!urls.length) return { added: 0, disabled: 0 };
    const values = urls.map((_, i) => `($${i + 1})`).join(',');
    const { rows } = await query<{ url: string }>(
      `INSERT INTO scrape_targets (url) VALUES ${values}
       ON CONFLICT (url) DO UPDATE SET enabled = TRUE
       RETURNING url`,
      urls,
    );
    const off = await query(
      `UPDATE scrape_targets SET enabled = FALSE WHERE enabled AND NOT (url = ANY($1::text[]))`,
      [urls],
    );
    return { added: rows.length, disabled: off.rowCount ?? 0 };
  },

  /** The next N targets that are actually due, least recently scraped first. */
  async dueScrapeTargets(limit: number): Promise<string[]> {
    const { rows } = await query<{ url: string }>(
      `SELECT url FROM scrape_targets
       WHERE enabled AND due_at <= now()
       ORDER BY last_scraped_at ASC NULLS FIRST, due_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.url);
  },

  /**
   * Record what a target produced and schedule its next visit.
   *
   * Yielded roles → come back after the base interval. Empty or errored →
   * back off 2^n, capped, so a page that cannot yield stops competing for the
   * budget with pages that can, but is never permanently dropped.
   */
  async recordScrapeResult(
    url: string,
    roles: number,
    baseHours: number,
    error?: string,
  ): Promise<void> {
    const MAX_BACKOFF_STEPS = 5; // base * 32; at 3h that is ~4 days
    await query(
      `UPDATE scrape_targets SET
         last_scraped_at   = now(),
         last_roles        = $2,
         total_roles       = total_roles + $2,
         consecutive_empty = CASE WHEN $2 > 0 THEN 0 ELSE LEAST(consecutive_empty + 1, $4) END,
         last_error        = $5,
         due_at            = now() + (
           $3::float * POWER(2, CASE WHEN $2 > 0 THEN 0 ELSE LEAST(consecutive_empty + 1, $4) END)
         ) * INTERVAL '1 hour'
       WHERE url = $1`,
      [url, roles, baseHours, MAX_BACKOFF_STEPS, error ?? null],
    );
  },

  /**
   * Put a target back in the queue shortly, WITHOUT counting it as empty.
   *
   * For when a page was fetched successfully but never parsed because our own
   * LLM budget ran out. Penalising it would be blaming the target for our
   * failure, and on a tight-quota day that would back off the entire list.
   */
  async requeueScrapeTarget(url: string, hours: number): Promise<void> {
    await query(
      `UPDATE scrape_targets
         SET due_at = now() + ($2::float * INTERVAL '1 hour')
       WHERE url = $1`,
      [url, hours],
    );
  },

  /** Operator view of the queue — what is due, what is starved, what is dead. */
  async scrapeQueueStatus(): Promise<{
    total: number; enabled: number; dueNow: number; neverScraped: number; producing: number;
  }> {
    const { rows } = await query<Record<string, string>>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE enabled)::int AS enabled,
              count(*) FILTER (WHERE enabled AND due_at <= now())::int AS due_now,
              count(*) FILTER (WHERE last_scraped_at IS NULL)::int AS never_scraped,
              count(*) FILTER (WHERE total_roles > 0)::int AS producing
       FROM scrape_targets`,
    );
    const r = rows[0];
    return {
      total: Number(r.total), enabled: Number(r.enabled), dueNow: Number(r.due_now),
      neverScraped: Number(r.never_scraped), producing: Number(r.producing),
    };
  },

  async setScrapeState(cursor: number, lastScrape: number): Promise<void> {
    await query(
      `INSERT INTO scrape_state (id, cursor, last_scrape)
       VALUES (1, $1, to_timestamp($2 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, last_scrape = EXCLUDED.last_scrape`,
      [cursor, lastScrape],
    );
  },

  // ---- the cached one-job demo ----

  async setDemoScore(jobId: string, score: number, reason: string, cvVariant: string): Promise<void> {
    await query('DELETE FROM demo_score');
    await query(
      `INSERT INTO demo_score (job_id, score, reason, cv_variant) VALUES ($1,$2,$3,$4)`,
      [jobId, score, reason, cvVariant],
    );
  },

  async getDemoJob(): Promise<ScoredJob | undefined> {
    const { rows } = await query<ScoredJobRow>(
      `SELECT j.*, d.score, d.reason, d.cv_variant,
              NULL::text AS status, NULL::text AS notes, NULL::boolean AS dismissed
       FROM demo_score d JOIN jobs j ON j.id = d.job_id
       LIMIT 1`,
    );
    return rows.length ? toScoredJob(rows[0]) : undefined;
  },

  // ---- joined dashboard reads ----

  async scoredJobs(userId: string): Promise<ScoredJob[]> {
    const { rows } = await query<ScoredJobRow>(
      `${SCORED_JOB_SELECT} ORDER BY s.score DESC NULLS LAST, j.id`,
      [userId],
    );
    return rows.map(toScoredJob);
  },

  /**
   * The dashboard list, filtered, sorted, paginated and trimmed in SQL.
   *
   * Replaces "load every row, filter in JS": 1,724 rows, 6.5s, 7.71MB — of
   * which 6.5MB was descriptions the list never shows. The snippet keeps cards
   * useful; the full text is one getScoredJob away when a card is opened.
   */
  async listScoredJobs(
    userId: string,
    opts: { minScore: number; source: string; includeDismissed: boolean; limit: number; offset: number },
  ): Promise<{ jobs: ScoredJob[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [userId];
    if (opts.minScore > 0) {
      params.push(opts.minScore);
      where.push(`COALESCE(s.score, 0) >= $${params.length}`);
    }
    if (opts.source) {
      params.push(opts.source);
      where.push(`j.source = $${params.length}`);
    }
    if (!opts.includeDismissed) where.push('COALESCE(m.dismissed, FALSE) = FALSE');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const joins = `FROM jobs j
      LEFT JOIN scores   s ON s.job_id = j.id AND s.user_id = $1
      LEFT JOIN job_meta m ON m.job_id = j.id AND m.user_id = $1
      ${clause}`;

    // ONE round trip, not two. EXPLAIN puts the query itself at ~1.5ms while a
    // round trip to Neon measures ~209ms, so latency — not Postgres — is the
    // cost, and a separate COUNT would double it for a number we can get from
    // a window function on the same scan.
    const paged = [...params, opts.limit, opts.offset];
    const { rows } = await query<ScoredJobRow & { total: string }>(
      `SELECT j.id, j.source, j.title, j.company, j.location, j.url, j.salary,
              j.posted_at, j.created_at,
              LEFT(j.description, 400) AS description,
              s.score, s.reason, s.cv_variant,
              m.status, m.notes, m.dismissed,
              count(*) OVER ()::int AS total
       ${joins}
       ORDER BY s.score DESC NULLS LAST, j.id
       LIMIT $${paged.length - 1} OFFSET $${paged.length}`,
      paged,
    );

    return {
      jobs: rows.map(toScoredJob),
      // count(*) OVER () counts the filtered set before LIMIT. With no rows
      // there is no window to read it from, which is correct: total is 0.
      total: rows.length ? Number(rows[0].total) : 0,
    };
  },

  async getScoredJob(userId: string, jobId: string): Promise<ScoredJob | undefined> {
    const { rows } = await query<ScoredJobRow>(
      `${SCORED_JOB_SELECT} WHERE j.id = $2`,
      [userId, jobId],
    );
    return rows.length ? toScoredJob(rows[0]) : undefined;
  },
};
