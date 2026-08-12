import { Job } from '../types';
import { isEngineeringTitle, openToIndia } from './ats-filter';
import { pooled } from './pool';

// SmartRecruiters — a properly public, documented, keyless job API.
//
//   GET https://api.smartrecruiters.com/v1/companies/{company}/postings
//
// The nicest of the enterprise boards to work with: no POST body, no session,
// no undocumented finder syntax, and it paginates honestly. The company
// identifier is the SmartRecruiters account name, which is usually the brand
// with spaces removed and is case-sensitive.
//
// Worth knowing: several of these employers block plain curl at their own
// careers domain (careers.servicenow.com is Cloudflare-403, www.arista.com
// answers 406) while this API serves the same listings without complaint. The
// marketing site being hostile says nothing about the board being available.
//
// Verified live 2026-08-12: Arista Networks 231 postings, ServiceNow 478.

interface SrCompany {
  /** Displayed as the employer. */
  company: string;
  /** SmartRecruiters account identifier. Case-sensitive. */
  id: string;
}

export const SMARTRECRUITERS_COMPANIES: SrCompany[] = [
  { company: 'Arista Networks', id: 'AristaNetworks' }, // 231
  { company: 'ServiceNow', id: 'ServiceNow' }, // 478
];

const API = 'https://api.smartrecruiters.com/v1/companies';
const UA = 'Mozilla/5.0 (compatible; Shortlist/1.0)';
const TIMEOUT_MS = 25_000;

// The API caps a page at 100 whatever is asked for.
const PAGE = 100;
const MAX_POSTINGS = 400;
// Descriptions need one request per posting, so the pass is bounded and only
// runs on what survives filtering.
const DETAIL_BUDGET = 60;
const DETAIL_CONCURRENCY = 6;

function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten the posting detail into scoreable prose.
 *
 * SmartRecruiters splits a description across named sections — company
 * description, job description, qualifications, additional information — and
 * which ones an employer fills in varies. Concatenating whatever is present
 * beats picking one field and finding it empty half the time.
 */
function detailText(d: any): string {
  const sections = d?.jobAd?.sections ?? {};
  return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => sections[k]?.text)
    .filter(Boolean)
    .map(stripHtml)
    .join(' ')
    .trim();
}

/**
 * Build a human- and filter-readable location string.
 *
 * `fullLocation` is preferred because `country` is a two-letter ISO code, not a
 * name: composing city/region/country by hand produced "Munich, de" and
 * "Bengaluru, in", so the India filter matched nothing and both companies
 * silently reported zero. `fullLocation` spells the country out.
 */
function locationOf(p: any): string {
  const l = p?.location ?? {};
  const base =
    String(l.fullLocation ?? '').replace(/,\s*,/g, ',').trim() ||
    [l.city, l.region, l.country].filter(Boolean).join(', ');
  return l.remote ? (base ? `${base} (Remote)` : 'Remote') : base;
}

async function fetchCompany(c: SrCompany): Promise<Job[]> {
  const now = new Date().toISOString();
  const postings: any[] = [];

  // Ask the API for India rather than pulling the whole board and filtering
  // here. ServiceNow publishes 476 postings of which 26 are in India, so the
  // server-side filter turns five pages into one and removes the risk of a
  // mid-pagination failure losing the company entirely.
  //
  // The trade-off is that a globally-remote role tagged to another country's
  // office will not appear. For enterprises this size that is a rounding error
  // next to the India offices, which is what this source is here for.
  for (let offset = 0; offset < MAX_POSTINGS; offset += PAGE) {
    let batch: any[];
    try {
      const page = await getJson(
        `${API}/${encodeURIComponent(c.id)}/postings?country=in&limit=${PAGE}&offset=${offset}`,
      );
      batch = page?.content ?? [];
    } catch {
      // Keep what has been collected. Throwing here used to lose the whole
      // company on a single bad page, which is how both employers reported
      // zero while their boards were plainly healthy.
      break;
    }
    postings.push(...batch);
    if (batch.length < PAGE) break;
  }

  // isEngineeringTitle is called directly rather than going through
  // filterEngineering, because that helper reads `.title` and SmartRecruiters
  // calls the field `.name`. Passing these postings to it typechecks — the
  // constraint is structural and `name` is just an extra property — and then
  // silently drops every row, because `undefined` is never an engineering
  // title. Both companies reported zero with a perfectly healthy API behind
  // them, which is the worst kind of failure: invisible.
  const wanted = postings
    .filter((p) => p?.id && p?.name && isEngineeringTitle(String(p.name)))
    .filter((p) => openToIndia(locationOf(p)))
    .slice(0, DETAIL_BUDGET);

  const bodies = await pooled(
    wanted.map((p) => async () => {
      try {
        return detailText(await getJson(`${API}/${encodeURIComponent(c.id)}/postings/${p.id}`));
      } catch {
        // Taken down between the list and the detail call. The list row is
        // still a real posting, so keep it without a description.
        return '';
      }
    }),
    DETAIL_CONCURRENCY,
  );

  return wanted.map((p, i): Job => ({
    id: `smartrecruiters:${c.id}:${p.id}`,
    source: 'smartrecruiters',
    title: String(p.name),
    company: c.company,
    location: locationOf(p),
    description: bodies[i] ?? '',
    // `ref` is the API's own record; applyUrl is where a human should land.
    url: String(p.applyUrl || p.ref || `https://jobs.smartrecruiters.com/${c.id}/${p.id}`),
    salary: null,
    postedAt: p.releasedDate ? new Date(p.releasedDate).toISOString() : null,
    createdAt: now,
  }));
}

export interface SmartRecruitersResult { company: string; jobs: Job[]; }

export async function fetchSmartRecruitersJobs(): Promise<SmartRecruitersResult[]> {
  const settled = await Promise.allSettled(SMARTRECRUITERS_COMPANIES.map(fetchCompany));
  return settled.map((s, i) => ({
    company: SMARTRECRUITERS_COMPANIES[i].company,
    // Already location-filtered inside fetchCompany, before the detail budget.
    jobs: s.status === 'fulfilled' ? s.value : [],
  }));
}
