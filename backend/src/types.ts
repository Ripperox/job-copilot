export interface Profile {
  resumeText: string;
  roles: string[];
  locations: string[];
  salaryFloorLPA: number | null;
  maxYoE: number | null; // max years of experience the candidate targets (e.g. 3)
  mustHaves: string[];
  cvVariants: string[];
}

export interface Job {
  id: string; // stable, e.g. "adzuna:12345"
  source: string;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  salary: string | null;
  postedAt: string | null;
  createdAt: string;
}

export interface Score {
  jobId: string;
  score: number; // 0-100
  reason: string;
  cvVariant: string;
  scoredAt: string;
}

export type JobStatus = 'new' | 'outreach' | 'applied' | 'interview' | 'rejected';

export const JOB_STATUSES: JobStatus[] = ['new', 'outreach', 'applied', 'interview', 'rejected'];

export interface JobMeta {
  status: JobStatus;
  notes: string;
  dismissed: boolean;
}

export type ScoredJob = Job & {
  score: number | null;
  reason: string | null;
  cvVariant: string | null;
  status: JobStatus;
  notes: string;
  dismissed: boolean;
};

export interface OutreachTarget {
  title: string; // e.g. "Engineering Manager"
  searchUrl: string; // a LinkedIn people-search URL for that title @ company
}

export interface Outreach {
  jobId: string;
  referralMessage: string; // short, personalized LinkedIn DM asking for a referral/feedback
  applicationNote: string; // "why this company / role" paragraph
  targets: OutreachTarget[]; // who to reach out to (search links, not scraped)
  cvVariant: string; // which CV to attach (from the job's score)
  generatedAt: string;
}
