import * as crypto from 'crypto';
import { Job, Profile } from '../types';
import { Config } from '../config';
import { scrapePage } from '../scrapers';
import { llmComplete, hasLLM } from '../llm';

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

export async function fetchScrapedJobs(profile: Profile, config: Config): Promise<Job[]> {
  if (!config.scrapeCareerPages.length) return [];

  const jobs: Job[] = [];
  for (const pageUrl of config.scrapeCareerPages) {
    try {
      const { result, provider } = await scrapePage(pageUrl, config);
      if (!result.content.trim()) {
        console.error(`[scraped] ${pageUrl} returned no content (via ${provider})`);
        continue;
      }
      const extracted = await extractJobs(result.content, pageUrl, profile, config);
      console.error(`[scraped] ${pageUrl} via ${provider}: ${extracted.length} roles`);
      jobs.push(...extracted);
    } catch (e: any) {
      // One dead career page must never fail the whole fetch.
      console.error(`[scraped] ${pageUrl} failed:`, String(e?.message ?? e).slice(0, 200));
    }
  }
  return jobs;
}

// Career pages have no common markup, so the LLM does the parsing. Without a key
// we skip rather than guess — a regex over arbitrary HTML produces garbage rows
// that then pollute the shared pool.
async function extractJobs(content: string, pageUrl: string, profile: Profile, config: Config): Promise<Job[]> {
  if (!hasLLM(config)) return [];

  const host = safeHost(pageUrl);
  const prompt = `Extract every currently-open ENGINEERING job from this careers page.

Ignore non-engineering roles (sales, marketing, finance, HR, support, legal).
Ignore anything that is not an actual open position (benefits copy, culture text, navigation).
Do NOT invent roles. If the page lists no engineering openings, return {"jobs": []}.

For each role return:
- title: the exact job title
- location: as written, or "" if absent
- experience: the stated years of experience, or "" if absent
- url: the direct link to the role if the page gives one, otherwise ""
- description: a 1-3 sentence factual summary of the role and its stack, from the page only

PAGE (${pageUrl}):
${selectJobRegion(content, MAX_PAGE_CHARS)}

Return ONLY JSON: {"jobs":[{"title":"","location":"","experience":"","url":"","description":""}]}`;

  let parsed: any;
  try {
    parsed = await askForJobs(prompt, config, 0);
  } catch (e) {
    console.error(`[scraped] extraction failed for ${pageUrl}:`, String((e as Error)?.message ?? e).slice(0, 200));
    return [];
  }
  if (!parsed) return [];

  const now = new Date().toISOString();
  const rows: any[] = Array.isArray(parsed?.jobs) ? parsed.jobs : [];

  return rows
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
