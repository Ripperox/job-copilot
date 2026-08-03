import { Job, Profile, Score, JobMeta, Outreach, JobStatus, OutreachTarget } from '../types';

// Postgres returns snake_case columns; the domain types are camelCase. These
// mappers are the only place that translation happens.

export interface JobRow {
  id: string; source: string; title: string; company: string; location: string;
  description: string; url: string; salary: string | null;
  posted_at: string | null; created_at: string;
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description,
    url: r.url,
    salary: r.salary,
    postedAt: r.posted_at,
    createdAt: r.created_at,
  };
}

export interface ProfileRow {
  resume_text: string; roles: string[]; locations: string[];
  salary_floor_lpa: number | null; max_yoe: number | null;
  must_haves: string[]; cv_variants: string[];
}

export function toProfile(r: ProfileRow): Profile {
  return {
    resumeText: r.resume_text,
    roles: r.roles,
    locations: r.locations,
    salaryFloorLPA: r.salary_floor_lpa,
    maxYoE: r.max_yoe,
    mustHaves: r.must_haves,
    cvVariants: r.cv_variants,
  };
}

export interface ScoreRow {
  job_id: string; score: number; reason: string; cv_variant: string; scored_at: string;
}

export function toScore(r: ScoreRow): Score {
  return {
    jobId: r.job_id,
    score: r.score,
    reason: r.reason,
    cvVariant: r.cv_variant,
    scoredAt: r.scored_at,
  };
}

export interface JobMetaRow { status: string; notes: string; dismissed: boolean }

export function toMeta(r: JobMetaRow): JobMeta {
  return { status: r.status as JobStatus, notes: r.notes, dismissed: r.dismissed };
}

export interface OutreachRow {
  job_id: string; referral_message: string; application_note: string;
  targets: OutreachTarget[]; cv_variant: string; generated_at: string;
}

export function toOutreach(r: OutreachRow): Outreach {
  return {
    jobId: r.job_id,
    referralMessage: r.referral_message,
    applicationNote: r.application_note,
    targets: r.targets,
    cvVariant: r.cv_variant,
    generatedAt: r.generated_at,
  };
}
