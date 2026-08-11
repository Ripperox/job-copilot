import { Job } from '../types';

// Shared location gate for the public ATS boards (Greenhouse / Lever / Ashby).
//
// Why this exists: these boards are free and unmetered, which makes them the
// right answer now that the paid aggregators are monthly-quota dead. But they
// are also huge — GitLab alone lists 185 roles, OKX 334 — and almost all of it
// is US-only. Ingesting everything would bury the pool and, worse, burn the
// scoring budget: the LLM free tier is the binding constraint, so every
// irrelevant job admitted here costs a real job somewhere else.
//
// Filtering at the source is far cheaper than scoring and then discarding.

const INDIA =
  /\b(india|bengaluru|bangalore|mumbai|pune|hyderabad|gurgaon|gurugram|delhi|noida|chennai|kolkata|ahmedabad)\b/i;

// "Remote" alone is not enough — "Remote - US" is the most common form on these
// boards and is useless here. Accept only genuinely open remote.
const OPEN_REMOTE = /\bremote\b/i;
const COUNTRY_LOCKED =
  /\b(remote\s*[-–,(]?\s*)?(usa?|united states|u\.s\.?|north america|canada|latam|latin america|emea|europe|uk|united kingdom|ireland|germany|france|spain|netherlands|poland|portugal|brazil|argentina|mexico|colombia|australia|new zealand|japan|korea|china|taiwan|singapore|philippines|vietnam|thailand|indonesia|israel|uae|dubai|nigeria|kenya|south africa)\b/i;
const GLOBAL = /\b(worldwide|global|anywhere|any location|remote[- ](global|worldwide|anywhere))\b/i;

/**
 * True when a posting is plausibly open to someone based in India.
 *
 * Order matters: an explicit India mention wins outright, then explicit
 * global-remote, and only then bare "remote" — but bare remote is rejected if
 * the same string names another country, which is how "Remote - United States"
 * gets excluded.
 */
export function openToIndia(location: string): boolean {
  const loc = (location || '').trim();
  if (!loc) return false;
  if (INDIA.test(loc)) return true;
  if (GLOBAL.test(loc)) return true;
  if (OPEN_REMOTE.test(loc) && !COUNTRY_LOCKED.test(loc)) return true;
  return false;
}

/** Drops postings that nobody in India could take. */
export function filterOpenToIndia(jobs: Job[]): Job[] {
  return jobs.filter((j) => openToIndia(j.location));
}

/**
 * Board tokens are lowercase slugs ("phonepe", "job-copilot"). Greenhouse's
 * board API does not return a company name — the previous code used the first
 * department, which produced companies called "Engineering" — so derive a
 * readable name from the token instead.
 */
export function companyFromToken(token: string): string {
  return token
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Engineering-title filter, for aggregator boards.
//
// The ATS boards in targets.ts are company-specific, so what comes back is
// broadly relevant. Aggregators are not: RemoteOK's feed returned "Beekeeper
// Academy of Achievement" and "General Staff Position", and Remotive answered
// `category=software-dev` with inside-sales roles. Storing those costs database
// rows and, worse, scoring budget — every junk row is a job the LLM might be
// asked to read.
//
// Deliberately generous. A false negative silently hides a real job, which is
// far more costly than a false positive that gets scored low and sinks. Titles
// are matched on word boundaries so "Go" does not match "Goalkeeper".
// ---------------------------------------------------------------------------

const ENGINEERING_TITLE =
  /\b(engineer|engineering|developer|programmer|software|sde|swe|backend|back[-\s]?end|frontend|front[-\s]?end|full[-\s]?stack|fullstack|devops|sre|platform|infrastructure|architect|data|ml|ai|machine\s?learning|qa|sdet|mobile|android|ios|web|cloud|security|api|database|dba)\b/i;

/** Titles that contain an engineering word but are not engineering jobs. */
const NOT_ENGINEERING =
  /\b(sales|recruiter|recruiting|account\s+executive|marketing|copywriter|customer\s+success|support\s+agent|teacher|tutor|nurse|driver|cleaner|janitorial|beekeeper|writer|editor|designer\s+of\s+content)\b/i;

export function isEngineeringTitle(title: string): boolean {
  const t = String(title ?? '');
  if (!t.trim()) return false;
  if (NOT_ENGINEERING.test(t)) return false;
  return ENGINEERING_TITLE.test(t);
}

export function filterEngineering<T extends { title: string }>(jobs: T[]): T[] {
  return jobs.filter((j) => isEngineeringTitle(j.title));
}
