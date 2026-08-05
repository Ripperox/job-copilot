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
