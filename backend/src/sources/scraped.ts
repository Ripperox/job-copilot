import * as crypto from 'crypto';
import { Job, Profile } from '../types';
import { Config } from '../config';
import { scrapePage } from '../scrapers';
import { db } from '../db';
import {
  llmComplete,
  hasLLM,
  isTerminalForRun,
  terminalReason,
  llmProviderChain,
  configForProvider,
} from '../llm';

// Company career pages as a job source.
//
// Why this exists alongside Adzuna/Jooble: those are aggregators, so every
// listing on them is already in front of everyone else. Career pages carry the
// same role earlier and with far less competition — and many roles never
// syndicate to an aggregator at all.
//
// Configure with SCRAPE_CAREER_PAGES (comma-separated URLs).

// Sized for the tightest provider we support: Groq's 12k tokens/minute. 12k
// chars is ~3k tokens, leaving room for the prompt. A 30k-char page produced a
// 413 in testing. Long pages shrink-and-retry below rather than being dropped.
const MAX_PAGE_CHARS = 12000;

// Gap between page fetches. Firecrawl's free tier is ~10 requests/minute, so
// ~7s keeps a full window comfortably under it.
const FETCH_SPACING_MS = Number(process.env.SCRAPE_FETCH_SPACING_MS ?? 7000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// When the last scrape ran. Career pages change daily at most, while the job
// fetch runs hourly — without this gate every tick would re-scrape every page
// and burn the month's scraping credits in a couple of days.
//
// Deliberately in-memory: a restart costs at most one extra scrape cycle, which
// the quota has headroom for, and it avoids a schema change purely for a clock.
let lastScrapeAt = 0;

// Where the rotating window starts next run, so a long target list is covered
// over several days instead of all at once.
let scrapeCursor = 0;

/** Exposed so the API can report when career pages were last read. */
export function lastScrapeTime(): number {
  return lastScrapeAt;
}

// Warn once per process rather than on every fetch, so the log says why the
// feature is dead without drowning the scheduler output.
let warnedNoTargets = false;

export async function fetchScrapedJobs(profile: Profile, config: Config): Promise<Job[]> {
  if (!config.scrapeCareerPages.length) {
    // This used to return silently, which made an unset variable and a failed
    // deploy look identical in the logs — the feature produced nothing for days
    // and said nothing about it. Never fail silently on a disabled feature.
    if (!warnedNoTargets) {
      console.error(
        '[scraped] SCRAPE_CAREER_PAGES is empty — career-page reading is OFF. ' +
          'Set it to a comma-separated list of career-page URLs; the scrapers ' +
          'themselves are fine (Jina needs no key), there is simply nothing to read.',
      );
      warnedNoTargets = true;
    }
    return [];
  }

  console.error(`[scraped] ${config.scrapeCareerPages.length} career page(s) configured`);

  // State lives in Postgres, not memory. The host restarts frequently and an
  // in-memory cursor reset to 0 every time, so the same first pages were read
  // over and over and the tail of the list was never reached.
  const state = await db.getScrapeState().catch(() => ({ cursor: 0, lastScrape: 0 }));
  lastScrapeAt = state.lastScrape;

  const dueAt = lastScrapeAt + config.scrapeIntervalHours * 60 * 60 * 1000;
  if (lastScrapeAt && Date.now() < dueAt) {
    const mins = Math.round((dueAt - Date.now()) / 60000);
    console.error(`[scraped] skipping — next career-page scrape due in ${mins} min`);
    return [];
  }

  // Read a rotating WINDOW of the target list rather than all of it.
  //
  // The binding constraint is not Firecrawl (1 credit/page) but wall-clock: each
  // page costs ~7s of pacing plus fetch plus LLM parsing, so reading all 24 in
  // one run took 465s measured. A run that long does not survive a free-tier
  // host that restarts on idle, and because nothing is written until the very
  // end, an interrupted run loses everything it gathered. Small windows finish
  // and commit; the cursor below carries the rotation across runs.
  const all = config.scrapeCareerPages;
  const size = Math.max(1, Math.min(config.scrapeMaxPagesPerRun, all.length));
  const start = state.cursor % all.length;
  const targets = Array.from({ length: size }, (_, i) => all[(start + i) % all.length]);

  // Advance the cursor and stamp the run BEFORE doing the work, so a crash
  // mid-run moves on to the next window instead of retrying the same one
  // forever and never reaching the rest of the list.
  lastScrapeAt = Date.now();
  await db.setScrapeState((start + size) % all.length, lastScrapeAt).catch((e) => {
    console.error('[scraped] could not persist scrape state:', e.message);
  });

  if (size < all.length) {
    console.error(
      `[scraped] reading ${size}/${all.length} pages this run (window from #${start}); ` +
      `full list covered every ${Math.ceil(all.length / size)} runs`,
    );
  }

  // 1. Fetch every page first. This is the cheap half (one Firecrawl credit
  //    each) and is independent of the LLM budget.
  //
  //    Paced: Firecrawl's free tier allows roughly 10 requests a minute, and
  //    firing a whole window back-to-back trips it — observed as 429s from the
  //    7th page onward. The fallback chain does rescue those via Jina, but
  //    Firecrawl extracts better, so it is worth waiting for.
  const fetched: { url: string; content: string }[] = [];
  for (const [i, pageUrl] of targets.entries()) {
    if (i > 0) await sleep(FETCH_SPACING_MS);
    try {
      const { result, provider } = await scrapePage(pageUrl, config);
      if (!result.content.trim()) {
        console.error(`[scraped] ${pageUrl} returned no content (via ${provider})`);
        continue;
      }
      fetched.push({ url: pageUrl, content: result.content });
    } catch (e: any) {
      // One dead career page must never fail the whole run.
      console.error(`[scraped] ${pageUrl} fetch failed:`, String(e?.message ?? e).slice(0, 160));
    }
  }

  // 2. Parse them in as FEW LLM requests as possible. Extraction — not
  //    Firecrawl — is the binding constraint, and providers cap on requests as
  //    well as tokens. One page per request wasted the request budget exactly
  //    the way one job per request did in the scorer.
  return extractFromPages(fetched, profile, config);
}

// Pages per LLM request, shaped by which limit binds for that provider:
//   gemini — request-limited (20/day free) with a huge context, so pack pages in
//   groq   — token-limited (12k/min), so one page at a time is already near the
//            ceiling; batching there would only cause 413s
//   anthropic — comfortable either way
const PAGES_PER_REQUEST: Record<string, number> = {
  // One page is ~3k tokens, which with the prompt already fills most of
  // Cerebras' ~8k free-tier context window.
  cerebras: 1,
  gemini: 4,
  groq: 1,
  anthropic: 3,
  heuristic: 0,
};

async function extractFromPages(
  pages: { url: string; content: string }[],
  profile: Profile,
  config: Config,
): Promise<Job[]> {
  if (!pages.length || !hasLLM(config)) return [];

  // Same failover discipline as the scorer: one dead free tier must not cost us
  // the whole scrape when another key is configured. Walk the chain, and only
  // give up on extraction once every provider has said no.
  const order = llmProviderChain(config);
  let p = 0;
  const jobs: Job[] = [];
  let requests = 0;
  const used: string[] = [];

  for (let i = 0; i < pages.length; ) {
    if (p >= order.length) {
      console.error('[scraped] every LLM provider is spent — stopping extraction for this run');
      break;
    }
    const provider = order[p];
    if (!used.includes(provider)) used.push(provider);
    const cfg = configForProvider(config, provider);
    const per = Math.max(1, PAGES_PER_REQUEST[provider] ?? 1);
    const group = pages.slice(i, i + per);

    try {
      requests++;
      const found = await extractGroup(group, cfg);
      for (const [url, rows] of found) jobs.push(...toJobs(rows, url, profile));
      i += group.length;
    } catch (e: unknown) {
      if (isTerminalForRun(e)) {
        console.error(
          `[scraped] ${provider} ${terminalReason(e)} — ${order[p + 1] ? `switching to ${order[p + 1]}` : 'no providers left'}`,
        );
        p++;
        continue; // same pages, next provider
      }
      // A group that fails for any other reason falls back to one page at a
      // time, so one awkward page cannot cost us the whole group.
      console.error(`[scraped] group of ${group.length} failed — retrying individually`);
      for (const page of group) {
        try {
          requests++;
          const one = await extractGroup([page], cfg);
          for (const [url, rows] of one) jobs.push(...toJobs(rows, url, profile));
        } catch (inner) {
          if (isTerminalForRun(inner)) {
            p++;
            break;
          }
          console.error(`[scraped] ${page.url}: ${String((inner as Error)?.message ?? inner).slice(0, 120)}`);
        }
      }
      i += group.length;
    }
  }

  console.error(
    `[scraped] ${jobs.length} roles from ${pages.length} pages in ${requests} LLM request(s) via ${used.join(' → ') || 'none'}`,
  );
  return jobs;
}

/**
 * Parse one GROUP of career pages in a single LLM request.
 *
 * Career pages have no common markup, so the LLM does the parsing. Results come
 * back keyed by page URL — never by array position — so a reordered or partial
 * response still maps to the right company.
 */
async function extractGroup(
  pages: { url: string; content: string }[],
  config: Config,
): Promise<Map<string, any[]>> {
  const blocks = pages
    .map(
      (p, i) => `--- PAGE ${i + 1} ---
url: ${p.url}
${selectJobRegion(p.content, MAX_PAGE_CHARS)}`,
    )
    .join('\n\n');

  const prompt = `Extract every currently-open ENGINEERING job from ${pages.length} careers page(s).

Ignore non-engineering roles (sales, marketing, finance, HR, support, legal).
Ignore anything that is not an actual open position (benefits copy, culture text, navigation).
Do NOT invent roles. A page with no engineering openings gets an empty jobs array.

For each role return:
- title: the exact job title
- location: as written, or "" if absent
- experience: the stated years of experience, or "" if absent
- url: the direct link to the role if the page gives one, otherwise ""
- description: a 1-3 sentence factual summary of the role and its stack, from the page only

${blocks}

Return ONLY JSON, one entry per page, using each page's "url" verbatim:
{"pages":[{"url":"","jobs":[{"title":"","location":"","experience":"","url":"","description":""}]}]}`;

  const parsed = await askForJobs(prompt, config, 0);
  const out = new Map<string, any[]>();
  if (!parsed) return out;

  // Preferred shape: grouped by page.
  const groups: any[] = Array.isArray(parsed?.pages) ? parsed.pages : [];
  for (const g of groups) {
    const url = typeof g?.url === 'string' ? g.url : '';
    if (!url) continue;
    // Match loosely — models sometimes normalise a trailing slash.
    const match = pages.find((p) => p.url === url || p.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
    if (match) out.set(match.url, Array.isArray(g.jobs) ? g.jobs : []);
  }

  // Fallback: a single-page group where the model ignored the wrapper and just
  // returned {"jobs":[...]}. Unambiguous only when we asked about one page.
  if (out.size === 0 && pages.length === 1 && Array.isArray(parsed?.jobs)) {
    out.set(pages[0].url, parsed.jobs);
  }

  return out;
}

/** Turn extracted rows for one page into Job records. */
function toJobs(rows: any[], pageUrl: string, _profile: Profile): Job[] {
  const host = safeHost(pageUrl);
  const now = new Date().toISOString();

  return (rows ?? [])
    .filter((r) => typeof r?.title === 'string' && r.title.trim())
    .map((r): Job => {
      const url = absoluteUrl(String(r.url ?? ''), pageUrl);
      const experience = String(r.experience ?? '').trim();
      return {
        // Career pages rarely expose a stable id, so derive one from company+title.
        // Deterministic, so re-fetching updates the row instead of duplicating it.
        id: `scraped:${host}:${hash(`${host}|${String(r.title).trim().toLowerCase()}`)}`,
        source: 'scraped',
        title: String(r.title).trim(),
        company: companyFromHost(host),
        location: String(r.location ?? '').trim(),
        // Keep the experience line inside the description so the seniority gate
        // and the scorer can both see it.
        description: [String(r.description ?? '').trim(), experience && `Experience required: ${experience}.`]
          .filter(Boolean)
          .join(' '),
        url: url || pageUrl,
        salary: null,
        postedAt: null,
        createdAt: now,
      };
    });
}

// Signals that a slice of a page is the actual openings list rather than nav,
// hero copy, or the benefits section.
const JOB_SIGNAL =
  /\b(engineer|developer|designer|manager|analyst|architect|intern|years?|yrs|remote|hybrid|on-?site|full-?time|apply|opening|position|vacanc)/gi;

/**
 * Pick the part of the page that actually lists jobs.
 *
 * Naive head-truncation fails on real career pages: the openings sit below the
 * navigation and marketing copy. On one page tested, the first role appeared at
 * character 14,767 while a 12,000-char head cut showed the model nothing but
 * menus. So instead of taking the start, take the window with the highest
 * density of job-listing signals.
 */
export function selectJobRegion(content: string, budget: number): string {
  if (content.length <= budget) return content;

  const WINDOW = 1000;
  const windows = Math.ceil(content.length / WINDOW);
  const scores: number[] = [];
  for (let i = 0; i < windows; i++) {
    const slice = content.slice(i * WINDOW, (i + 1) * WINDOW);
    scores.push((slice.match(JOB_SIGNAL) ?? []).length);
  }

  // Densest contiguous run of windows that fits the budget.
  const span = Math.max(1, Math.floor(budget / WINDOW));
  let best = 0;
  let bestSum = -1;
  let running = scores.slice(0, span).reduce((a, b) => a + b, 0);
  bestSum = running;
  for (let i = span; i < windows; i++) {
    running += scores[i] - scores[i - span];
    if (running > bestSum) {
      bestSum = running;
      best = i - span + 1;
    }
  }

  // Keep the page title for context, then the densest region.
  const header = content.slice(0, 200);
  return `${header}\n…\n${content.slice(best * WINDOW, best * WINDOW + budget)}`;
}

// Calls the LLM, halving the page content and retrying when the request is
// rejected for SIZE (413, or a 400 complaining about length). A rate limit or a
// bad key is terminal — shrinking would not help, so it propagates.
async function askForJobs(prompt: string, config: Config, depth: number): Promise<any | null> {
  try {
    const text = await llmComplete(prompt, config, 8192);
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch (e: unknown) {
    const status = (e as any)?.status;
    const tooBig = status === 413 || (status === 400 && /too large|length|token/i.test(String((e as Error)?.message)));
    if (!tooBig || depth >= 2) throw e;

    // Cut the PAGE portion in half, keeping the instructions intact.
    const marker = '\nPAGE (';
    const cut = prompt.indexOf(marker);
    if (cut < 0) throw e;
    const head = prompt.slice(0, cut);
    const body = prompt.slice(cut);
    const shrunk = head + body.slice(0, Math.floor(body.length / 2)) +
      '\n\nReturn ONLY JSON: {"jobs":[{"title":"","location":"","experience":"","url":"","description":""}]}';
    console.error(`[scraped] page too large for the model — retrying at half size (attempt ${depth + 2})`);
    return askForJobs(shrunk, config, depth + 1);
  }
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

// "careers.acme.com" -> "Acme". Good enough for display; the URL is the truth.
function companyFromHost(host: string): string {
  const parts = host.split('.').filter((p) => !['www', 'careers', 'jobs', 'apply', 'boards'].includes(p));
  const name = parts[0] ?? host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function absoluteUrl(href: string, base: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}
