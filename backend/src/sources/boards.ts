import { Job } from '../types';
import { filterEngineering } from './ats-filter';

// Public remote job boards that expose free, key-less feeds.
//
// These are aggregators, not company career pages, so they do NOT belong in
// targets.ts — scraping an aggregator with Firecrawl costs a credit per page to
// re-fetch data the site already hands out as JSON. Measured 2026-08-11:
//
//   RemoteOK   https://remoteok.com/api                 JSON  ~100 jobs
//   Remotive   https://remotive.com/api/remote-jobs     JSON    20 jobs (hard
//              cap — limit=, category= and search= are all ignored)
//   WWR        weworkremotely.com/categories/*.rss      RSS   ~300 across the
//              engineering feeds; the all-jobs feed returns 100 of everything,
//              so the category feeds are both larger and better targeted
//
// Boards deliberately left out, and why:
//   echojobs.io, remotive.io   403 behind Cloudflare
//   remotists.com              does not resolve
//   findwork.dev               401, needs an API key
//   LinkedIn, Wellfound,       auth-walled; scraping them breaks their terms
//   Instahyre, CutShort        and gets the account banned
//
// Everything reachable-but-HTML lives in targets.ts for the Firecrawl queue.

const UA = 'Mozilla/5.0 (compatible; Shortlist/1.0; +https://github.com/Ripperox/agentflow)';
const TIMEOUT_MS = 20_000;

async function getText(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// RemoteOK — JSON array. The FIRST element is a legal notice, not a job; taking
// it as one puts a row titled "API Terms of Service" in the user's list.
// ---------------------------------------------------------------------------
async function remoteOk(): Promise<Job[]> {
  const raw = JSON.parse(await getText('https://remoteok.com/api'));
  const now = new Date().toISOString();
  return (Array.isArray(raw) ? raw.slice(1) : [])
    .filter((j: any) => j?.id && j?.position)
    .map((j: any): Job => ({
      id: `remoteok:${j.id}`,
      source: 'remoteok',
      title: String(j.position),
      company: String(j.company ?? 'Unknown'),
      location: String(j.location || 'Remote'),
      description: stripHtml(j.description ?? ''),
      url: String(j.url ?? j.apply_url ?? `https://remoteok.com/l/${j.id}`),
      salary:
        j.salary_min && j.salary_max
          ? `$${Number(j.salary_min).toLocaleString()}–$${Number(j.salary_max).toLocaleString()}`
          : null,
      postedAt: j.epoch ? new Date(Number(j.epoch) * 1000).toISOString() : null,
      createdAt: now,
    }));
}

// ---------------------------------------------------------------------------
// Remotive — JSON. Capped at 20 by the server whatever query you send.
// ---------------------------------------------------------------------------
async function remotive(): Promise<Job[]> {
  const raw = JSON.parse(await getText('https://remotive.com/api/remote-jobs?category=software-dev'));
  const now = new Date().toISOString();
  return (raw?.jobs ?? [])
    .filter((j: any) => j?.id && j?.title)
    .map((j: any): Job => ({
      id: `remotive:${j.id}`,
      source: 'remotive',
      title: String(j.title),
      company: String(j.company_name ?? 'Unknown'),
      location: String(j.candidate_required_location || 'Remote'),
      description: stripHtml(j.description ?? ''),
      url: String(j.url),
      salary: j.salary ? String(j.salary) : null,
      postedAt: j.publication_date ? new Date(j.publication_date).toISOString() : null,
      createdAt: now,
    }));
}

// ---------------------------------------------------------------------------
// We Work Remotely — RSS per category.
//
// Parsed with regex rather than an XML library on purpose: adding a dependency
// to read four predictable fields out of a feed we control the URL of is not
// worth the supply chain. If WWR ever changes shape this returns nothing and
// the source reports zero, which the health panel already surfaces.
// ---------------------------------------------------------------------------
const WWR_FEEDS = [
  'remote-back-end-programming-jobs',
  'remote-full-stack-programming-jobs',
  'remote-front-end-programming-jobs',
  'remote-devops-sysadmin-jobs',
  'remote-programming-jobs',
];

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return stripHtml(m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, ''));
}

async function wwrFeed(category: string): Promise<Job[]> {
  const xml = await getText(`https://weworkremotely.com/categories/${category}.rss`);
  const now = new Date().toISOString();
  const items = xml.split(/<item>/i).slice(1);

  return items
    .map((block): Job | null => {
      const link = tag(block, 'link');
      const rawTitle = tag(block, 'title');
      if (!link || !rawTitle) return null;

      // WWR titles are "Company: Role". Splitting gives a real company column
      // instead of every row reading "We Work Remotely".
      const idx = rawTitle.indexOf(':');
      const company = idx > 0 ? rawTitle.slice(0, idx).trim() : 'Unknown';
      const title = idx > 0 ? rawTitle.slice(idx + 1).trim() : rawTitle;

      const pub = tag(block, 'pubDate');
      const posted = pub ? new Date(pub) : null;

      return {
        // The URL is the only stable identifier in the feed.
        id: `wwr:${link.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '')}`,
        source: 'weworkremotely',
        title,
        company,
        location: tag(block, 'region') || 'Remote',
        description: tag(block, 'description'),
        url: link,
        salary: null,
        postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
        createdAt: now,
      };
    })
    .filter((j): j is Job => j !== null);
}

async function weWorkRemotely(): Promise<Job[]> {
  const settled = await Promise.allSettled(WWR_FEEDS.map(wwrFeed));
  const jobs: Job[] = [];
  for (const s of settled) if (s.status === 'fulfilled') jobs.push(...s.value);
  // The category feeds overlap — a full-stack role appears in two of them.
  const seen = new Set<string>();
  return jobs.filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}

// ---------------------------------------------------------------------------

export interface BoardResult { source: string; jobs: Job[]; }

/**
 * Fetch every free board concurrently.
 *
 * Returns per-board results rather than one flat list so the caller can record
 * health and counts for each — a board that starts returning nothing should be
 * visible in the status panel, not silently absorbed into a total.
 */
export async function fetchBoardJobs(): Promise<BoardResult[]> {
  const boards: { source: string; run: () => Promise<Job[]> }[] = [
    { source: 'remoteok', run: remoteOk },
    { source: 'remotive', run: remotive },
    { source: 'weworkremotely', run: weWorkRemotely },
  ];

  const settled = await Promise.allSettled(boards.map((b) => b.run()));
  return settled.map((s, i) => ({
    source: boards[i].source,
    // Aggregators carry every job type. Filtering here rather than downstream
    // keeps non-engineering roles out of the database entirely, so they never
    // consume a row or a scoring call.
    jobs: s.status === 'fulfilled' ? filterEngineering(s.value) : [],
  }));
}

export const BOARD_SOURCES = ['remoteok', 'remotive', 'weworkremotely'] as const;
