export type SalaryPeriod = 'year' | 'month' | 'hour';

export interface SalaryFloor {
  /** The number of `currency` units, e.g. 1500000 INR/year or 1200000/month. */
  amount: number | null;
  /** ISO 4217 code, e.g. 'INR', 'USD', 'EUR'. */
  currency: string;
  /** Whether the amount is per year, month or hour. */
  period: SalaryPeriod;
}

export interface Profile {
  resumeText: string;
  roles: string[];
  locations: string[];
  salaryFloor: SalaryFloor;
  maxYoE: number | null; // max years of experience the candidate targets (e.g. 3)
  mustHaves: string[];
  cvVariants: string[];
}

const LAKH = 100_000;

/**
 * Backward-compatible LPA footprint for a salary floor.
 *
 * The legacy `salary_floor_lpa` column held lakhs of INR per year. Keeping it
 * populated (for currencies and periods that map cleanly) means any old code,
 * report or query that still reads it stays correct. It is a derived view of
 * the structured floor, never the source of truth. Returns null when there is
 * no amount worth mirroring (e.g. a monthly EUR figure is meaningless as
 * "LPA").
 */
export function salaryFloorToLPA(floor: SalaryFloor): number | null {
  if (floor.amount == null) return null;
  const a = floor.amount;
  if (floor.currency !== 'INR') return null; // a foreign figure has no LPA meaning
  if (floor.period === 'year') return a / LAKH;
  if (floor.period === 'month') return (a * 12) / LAKH;
  if (floor.period === 'hour') return null; // hourly INR is not a comparable annual figure
  return null;
}

const PERIOD_LABEL: Record<SalaryPeriod, string> = {
  year: 'per year',
  month: 'per month',
  hour: 'per hour',
};

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function pad(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return trim(n);
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** "₹15 LPA", "$120k per year", "€5k per month" — a plain line for an LLM prompt. */
export function formatSalaryFloor(floor: SalaryFloor): string {
  if (floor.amount == null) return 'not set';
  const sym = CURRENCY_SYMBOL[floor.currency] ?? `${floor.currency} `;
  const amount = floor.currency === 'INR' && floor.period === 'year'
    ? `${trim(floor.amount / LAKH)} LPA`
    : `${pad(floor.amount)} ${PERIOD_LABEL[floor.period]}`;
  return `${sym}${amount}`;
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
