import { query } from './pool';
import { Job, Profile, Score, JobMeta, Outreach, ScoredJob } from '../types';
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

export const db = {
  async ensureUser(id: string, email = '', name = ''): Promise<void> {
    await query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, email, name],
    );
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

  async allJobs(): Promise<Job[]> {
    const { rows } = await query<JobRow>('SELECT * FROM jobs');
    return rows.map(toJob);
  },

  // ---- profile (per user) ----

  async getProfile(userId: string): Promise<Profile | null> {
    const { rows } = await query<ProfileRow>(
      `SELECT resume_text, roles, locations, salary_floor_lpa, max_yoe, must_haves, cv_variants
       FROM profiles WHERE user_id = $1`,
      [userId],
    );
    return rows.length ? toProfile(rows[0]) : null;
  },

  async setProfile(userId: string, p: Profile): Promise<Profile> {
    await query(
      `INSERT INTO profiles (user_id, resume_text, roles, locations, salary_floor_lpa, max_yoe, must_haves, cv_variants)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET
         resume_text = EXCLUDED.resume_text, roles = EXCLUDED.roles,
         locations = EXCLUDED.locations, salary_floor_lpa = EXCLUDED.salary_floor_lpa,
         max_yoe = EXCLUDED.max_yoe, must_haves = EXCLUDED.must_haves,
         cv_variants = EXCLUDED.cv_variants`,
      [userId, p.resumeText, p.roles, p.locations, p.salaryFloorLPA, p.maxYoE, p.mustHaves, p.cvVariants],
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

  // ---- joined dashboard reads ----

  async scoredJobs(userId: string): Promise<ScoredJob[]> {
    const { rows } = await query<ScoredJobRow>(
      `${SCORED_JOB_SELECT} ORDER BY s.score DESC NULLS LAST, j.id`,
      [userId],
    );
    return rows.map(toScoredJob);
  },

  async getScoredJob(userId: string, jobId: string): Promise<ScoredJob | undefined> {
    const { rows } = await query<ScoredJobRow>(
      `${SCORED_JOB_SELECT} WHERE j.id = $2`,
      [userId, jobId],
    );
    return rows.length ? toScoredJob(rows[0]) : undefined;
  },
};
