import { query } from './db/pool';

// How much of each API's allowance is left.
//
// Health tracking already said whether a provider was working. It could not say
// how close to its ceiling it was, so the first sign of an exhausted quota was
// everything stopping at once. This counts the requests we make and shows them
// against the plan's cap.
//
// Two honesty constraints shape the whole module:
//
//   1. These are OUR counts, not the provider's. If a key is shared with
//      something else, or a request fails before it is billed, the numbers
//      drift. It is a close estimate and the UI must not pretend otherwise.
//   2. The caps are CONFIGURED, not discovered. No provider here exposes
//      "remaining" over the API, so the ceiling is whatever the operator says
//      their plan is. The defaults below are the published free-tier figures at
//      the time of writing, and free tiers change without notice — hence the
//      env override on every one.

export type UsageWindow = 'day' | 'month';

export interface Quota {
  name: string;
  /** How it is written in the product, rather than the internal source id. */
  label: string;
  kind: 'model' | 'jobs' | 'scrape';
  /** Requests per window, or null where the plan has no fixed request cap. */
  limit: number | null;
  window: UsageWindow;
  /** Why the number is what it is — shown on hover, so it can be checked. */
  note: string;
}

function envLimit(key: string, fallback: number | null): number | null {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  if (/^(none|null|unlimited)$/i.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Every API this deployment can spend, and what it is allowed to spend.
 *
 * Read fresh rather than frozen at import so a limit can be corrected with an
 * env var and a restart, without a code change.
 */
export function quotas(): Quota[] {
  return [
    // ---- scoring models ----
    {
      name: 'groq', label: 'Groq', kind: 'model', window: 'day',
      limit: envLimit('GROQ_DAILY_LIMIT', 1_000),
      note: 'Free tier, per model. Groq also caps tokens per minute, which bites first on long postings.',
    },
    {
      name: 'gemini', label: 'Gemini', kind: 'model', window: 'day',
      limit: envLimit('GEMINI_DAILY_LIMIT', 250),
      note: 'Free tier request-per-day cap. Varies by model and changes often.',
    },
    {
      name: 'cerebras', label: 'Cerebras', kind: 'model', window: 'day',
      limit: envLimit('CEREBRAS_DAILY_LIMIT', 14_400),
      note: 'Free tier. Tokens per day usually run out before requests do.',
    },
    {
      name: 'anthropic', label: 'Claude', kind: 'model', window: 'day',
      limit: envLimit('ANTHROPIC_DAILY_LIMIT', null),
      note: 'Pay as you go — metered in credit, not in requests, so there is no bar to draw.',
    },

    // ---- job sources that cost something ----
    {
      name: 'adzuna', label: 'Adzuna', kind: 'jobs', window: 'month',
      limit: envLimit('ADZUNA_MONTHLY_LIMIT', 1_000),
      note: 'Free registration tier, counted per calendar month.',
    },
    {
      name: 'jsearch', label: 'JSearch', kind: 'jobs', window: 'month',
      limit: envLimit('JSEARCH_MONTHLY_LIMIT', 200),
      note: 'RapidAPI free plan. Overage is charged rather than refused, so this one is worth watching.',
    },
    {
      name: 'activejobs', label: 'Active Jobs DB', kind: 'jobs', window: 'month',
      limit: envLimit('ACTIVEJOBS_MONTHLY_LIMIT', 200),
      note: 'RapidAPI free plan.',
    },
    {
      name: 'linkedin', label: 'LinkedIn Jobs', kind: 'jobs', window: 'month',
      limit: envLimit('LINKEDIN_MONTHLY_LIMIT', 200),
      note: 'RapidAPI free plan.',
    },
    {
      name: 'jooble', label: 'Jooble', kind: 'jobs', window: 'day',
      limit: envLimit('JOOBLE_DAILY_LIMIT', 500),
      note: 'Set by Jooble per key on request.',
    },

    // ---- job sources that cost nothing ----
    // Kept visible on purpose. Most of the pool arrives through these, and a
    // panel that only listed the metered APIs would imply the opposite.
    {
      name: 'greenhouse', label: 'Greenhouse', kind: 'jobs', window: 'day',
      limit: envLimit('GREENHOUSE_DAILY_LIMIT', null),
      note: 'Public board API. No key, no published cap.',
    },
    {
      name: 'lever', label: 'Lever', kind: 'jobs', window: 'day',
      limit: envLimit('LEVER_DAILY_LIMIT', null),
      note: 'Public board API. No key, no published cap.',
    },
    {
      name: 'ashby', label: 'Ashby', kind: 'jobs', window: 'day',
      limit: envLimit('ASHBY_DAILY_LIMIT', null),
      note: 'Public board API. No key, no published cap.',
    },

    // ---- career-page reading ----
    {
      name: 'scraped', label: 'Career pages', kind: 'scrape', window: 'day',
      limit: envLimit('SCRAPE_DAILY_LIMIT', null),
      note: 'Pages read from company sites. Bounded by the queue, not by a plan.',
    },
  ];
}

/** The bucket a request made now belongs to. */
export function periodFor(window: UsageWindow, at = new Date()): string {
  const iso = at.toISOString();
  return window === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** When the current bucket empties, so the UI can say "resets in 3h". */
export function resetsAt(window: UsageWindow, at = new Date()): string {
  const d = new Date(at);
  if (window === 'month') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

const windowOf = new Map(quotas().map((q) => [q.name, q.window]));

/**
 * Record requests against an API. Never throws: a counter must not be able to
 * fail the work it is counting.
 */
export async function bump(name: string, n = 1): Promise<void> {
  if (n <= 0) return;
  try {
    const period = periodFor(windowOf.get(name) ?? 'day');
    await query(
      `INSERT INTO api_usage (name, period, requests) VALUES ($1, $2, $3)
       ON CONFLICT (name, period) DO UPDATE SET requests = api_usage.requests + EXCLUDED.requests`,
      [name, period, n],
    );
  } catch (e: any) {
    console.error(`[usage] could not count ${name}:`, e.message);
  }
}

export interface UsageRow extends Quota {
  used: number;
  /** null where there is no limit to be a fraction of. */
  fraction: number | null;
  remaining: number | null;
  resetsAt: string;
}

/** Current spend for every known API, whether or not it has been used yet. */
export async function summary(): Promise<UsageRow[]> {
  const qs = quotas();
  // One query for both window types: ask for each name's current bucket.
  const wanted = qs.map((q) => [q.name, periodFor(q.window)] as const);
  const { rows } = await query<{ name: string; period: string; requests: number }>(
    `SELECT name, period, requests FROM api_usage
     WHERE (name, period) IN (${wanted.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})`,
    wanted.flatMap(([n, p]) => [n, p]),
  );
  const used = new Map(rows.map((r) => [r.name, Number(r.requests)]));

  return qs.map((q) => {
    const u = used.get(q.name) ?? 0;
    return {
      ...q,
      used: u,
      fraction: q.limit ? Math.min(1, u / q.limit) : null,
      remaining: q.limit ? Math.max(0, q.limit - u) : null,
      resetsAt: resetsAt(q.window),
    };
  });
}
