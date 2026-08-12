import { Job } from '../types';
import { filterEngineering, openToIndia } from './ats-filter';
import { pooled } from './pool';

// Workday (myworkdayjobs.com) — the ATS most large enterprises run.
//
// Workday has no public/documented job API, but every Workday career site is a
// thin React app talking to the same JSON endpoint underneath, and that endpoint
// takes no key:
//
//   POST https://{tenant}.{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//        {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
//
// This matters far more than the one company it was added for. Cloudera is the
// first tenant here; adding any other Workday employer is three strings in the
// table below, no new code, no Firecrawl credits. That is the whole reason this
// is a platform module and not a Cloudera module.
//
// Two shapes, and you need both:
//
//   LIST   title, externalPath, locationsText, remoteType, bulletFields[0]=reqId,
//          and postedOn as PROSE — "Posted Today", "Posted 30+ Days Ago". No
//          description, no real date.
//   DETAIL GET /wday/cxs/{tenant}/{site}{externalPath} → jobPostingInfo with the
//          full jobDescription (~8 KB of HTML) and startDate as a real ISO date.
//
// So the list alone is not enough. Scoring reads the description, and a job that
// arrives as a bare title scores on title alone — below the UI's floor, which
// means invisible. Hence the detail pass, bounded (see DETAIL_BUDGET).

interface Tenant {
  /** Displayed as the employer. */
  company: string;
  /** Subdomain — the {tenant} in both the host and the path. */
  tenant: string;
  /** Which Workday pod the tenant is on: wd1, wd3, wd5, … Not guessable; read it off their careers link. */
  host: string;
  /** The career site's own name. Usually "External" or similar, but arbitrary. */
  site: string;
  /**
   * Workday serves tenants from two different domains and the choice is per
   * tenant, not per pod. Most are on myworkdayjobs.com; some — Wells Fargo, for
   * one — are on myworkdaysite.com, where the host is the FIRST label:
   *
   *   cloudera.wd5.myworkdayjobs.com   ← tenant first
   *   wd1.myworkdaysite.com/…/wf/…     ← pod first, tenant only in the path
   *
   * Getting this wrong returns a 404 that looks exactly like a renamed site,
   * so it is spelled out per tenant rather than guessed.
   */
  domain?: 'myworkdayjobs.com' | 'myworkdaysite.com';
}

// Every entry verified live on 2026-08-12 by POSTing to its /jobs endpoint and
// reading back a total. The number in the comment is that total — it is the
// employer's whole board, before the engineering and India filters run.
export const WORKDAY_TENANTS: Tenant[] = [
  { company: 'Cloudera', tenant: 'cloudera', host: 'wd5', site: 'External_Career' }, // 82
  { company: 'Morgan Stanley', tenant: 'ms', host: 'wd5', site: 'External' }, // 1400
  { company: 'Barclays', tenant: 'barclays', host: 'wd3', site: 'External_Career_Site_Barclays' }, // 1097
  { company: 'Citi', tenant: 'citi', host: 'wd5', site: '2' }, // 2000, looks server-capped
  { company: 'Visa', tenant: 'visa', host: 'wd5', site: 'Visa' }, // 778
  { company: 'Mastercard', tenant: 'mastercard', host: 'wd1', site: 'CorporateCareers' }, // 1128
  { company: 'PayPal', tenant: 'paypal', host: 'wd1', site: 'jobs' }, // 109
  { company: 'Sprinklr', tenant: 'sprinklr', host: 'wd1', site: 'careers' }, // 85
  { company: 'Salesforce', tenant: 'salesforce', host: 'wd12', site: 'External_Career_Site' }, // 1505
  { company: 'Palo Alto Networks', tenant: 'paloaltonetworks', host: 'wd5', site: 'panwexternalcareers' }, // 1416
  { company: 'Cohesity', tenant: 'cohesity', host: 'wd5', site: 'Cohesity_Careers' }, // 195

  // These three publish through Phenom, whose careers sites are the ones you
  // find first. Phenom's own API is reachable — POST /widgets with
  // ddoKey=refineSearch and jobs=true — but it returns a truncated teaser
  // instead of a description, and every applyUrl it hands back points straight
  // at Workday. So the skin was skipped and the tenant read out of the
  // applyUrl, which gives full descriptions and real dates for free. That is
  // also why Adobe and Warner Bros are no longer in targets.ts.
  { company: 'Adobe', tenant: 'adobe', host: 'wd5', site: 'external_experienced' }, // 799
  { company: 'Warner Bros Discovery', tenant: 'warnerbros', host: 'wd5', site: 'global' }, // 445
  { company: 'Cisco', tenant: 'cisco', host: 'wd5', site: 'Cisco_Careers' }, // 1144
  { company: 'Expedia', tenant: 'expedia', host: 'wd108', site: 'search' }, // 150
  {
    company: 'Wells Fargo',
    tenant: 'wf',
    host: 'wd1',
    site: 'WellsFargoJobs',
    domain: 'myworkdaysite.com', // 1719
  },
];

const UA = 'Mozilla/5.0 (compatible; Shortlist/1.0)';
const TIMEOUT_MS = 25_000;

// Workday silently clamps the page size to 20 regardless of what is asked for,
// so this is its number, not a choice.
const PAGE = 20;
// Ceiling on postings pulled per tenant per run. Raised from 200 once the big
// banks came in: Citi and Cisco carry over a thousand postings each and their
// India roles are not in the first 200, so a low cap silently returned nothing
// for exactly the largest employers.
const MAX_POSTINGS = 600;
// Ceiling on detail requests per tenant per run. One request per job, so an
// unbounded pass over a large tenant is thousands of hits on someone else's
// server for a list that barely changes between runs. Postings come back newest
// first, so the budget is spent on the ones most worth having.
const DETAIL_BUDGET = 80;
// Detail requests in flight at once.
const DETAIL_CONCURRENCY = 6;

// The two domains order their labels differently. On myworkdaysite.com the pod
// comes first and the tenant appears only in the path, so the tenant subdomain
// must NOT be prepended or every request 404s.
function base(t: Tenant): string {
  return t.domain === 'myworkdaysite.com'
    ? `https://${t.host}.myworkdaysite.com`
    : `https://${t.tenant}.${t.host}.myworkdayjobs.com`;
}

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

async function json(url: string, init?: RequestInit): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': UA, ...(init?.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn Workday's prose timestamp into a date.
 *
 * The list endpoint reports "Posted Today" / "Posted Yesterday" /
 * "Posted 5 Days Ago" / "Posted 30+ Days Ago" — never a real date. Freshness
 * drives ranking, so this is worth recovering rather than dropping to null. The
 * detail pass overwrites it with the true startDate where the budget reaches;
 * this is the fallback for the rest.
 *
 * "30+ Days Ago" resolves to exactly 30 days, which is a floor and not a
 * measurement — anything that old sorts to the bottom regardless.
 */
export function parsePostedOn(text: string, now = new Date()): string | null {
  const s = String(text ?? '').toLowerCase();
  const days = /today/.test(s)
    ? 0
    : /yesterday/.test(s)
      ? 1
      : Number(s.match(/(\d+)\+?\s*day/)?.[1] ?? NaN);
  if (!Number.isFinite(days)) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

async function fetchTenant(t: Tenant): Promise<Job[]> {
  const now = new Date().toISOString();
  const endpoint = `${base(t)}/wday/cxs/${t.tenant}/${t.site}/jobs`;
  const postings: any[] = [];

  for (let offset = 0; offset < MAX_POSTINGS; offset += PAGE) {
    let batch: any[];
    try {
      const page = await json(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: '' }),
      });
      batch = page?.jobPostings ?? [];
    } catch {
      // Keep what has already been collected instead of losing the tenant.
      //
      // Citi is why this exists. Its board is 2,000 postings, which is 30 pages
      // at Workday's fixed page size of 20, and a single rate-limited page
      // partway through used to throw out of this loop and take all 2,000 with
      // it — the tenant reported zero while looking perfectly healthy in code.
      // The deeper the paging, the likelier a blip, so the biggest and most
      // valuable employers were exactly the ones that failed.
      break;
    }
    postings.push(...batch);
    // Stop on a short page rather than trusting `total`: the count is computed
    // before facet filtering and overshoots, which walks the offset past the end
    // and burns a request per page for nothing.
    if (batch.length < PAGE) break;
  }

  // BOTH filters run before the detail pass, and the order matters more than it
  // looks. Filtering only by title here and leaving the location filter until
  // after the slice silently returned ZERO for the big tenants: Cisco has 1144
  // postings and its first 80 engineering roles are all outside India, so the
  // budget was spent entirely on rows that were about to be discarded. The
  // locationsText in the list response is enough to filter on, so use it here
  // rather than paying for descriptions that get thrown away.
  const wanted = filterEngineering(postings.filter((p) => p?.title && p?.externalPath))
    .filter((p) => openToIndia(String(p.locationsText ?? '')))
    .slice(0, DETAIL_BUDGET);

  const details = await pooled(
    wanted.map((p) => async () => {
      try {
        const d = await json(`${base(t)}/wday/cxs/${t.tenant}/${t.site}${p.externalPath}`);
        return d?.jobPostingInfo ?? null;
      } catch {
        // A posting pulled between the list and the detail call 404s here. The
        // list row is still a real job, so keep it and go without description.
        return null;
      }
    }),
    DETAIL_CONCURRENCY,
  );

  return wanted.map((p, i): Job => {
    const d = details[i];
    return {
      id: `workday:${t.tenant}:${p.bulletFields?.[0] ?? p.externalPath}`,
      source: 'workday',
      title: String(p.title),
      company: t.company,
      location: String(p.locationsText || d?.location || ''),
      description: d?.jobDescription ? stripHtml(d.jobDescription) : '',
      url: `${base(t)}/${t.site}${p.externalPath}`,
      salary: null,
      postedAt: d?.startDate
        ? new Date(d.startDate).toISOString()
        : parsePostedOn(p.postedOn),
      createdAt: now,
    };
  });
}

export interface WorkdayResult { company: string; jobs: Job[]; }

/**
 * Fetch every configured Workday tenant concurrently.
 *
 * Per-tenant results rather than one flat list, matching boards.ts: a tenant
 * that starts returning nothing (renamed site, moved pod) should show as zero in
 * the health panel instead of vanishing into a total.
 */
export async function fetchWorkdayJobs(): Promise<WorkdayResult[]> {
  const settled = await Promise.allSettled(WORKDAY_TENANTS.map(fetchTenant));
  return settled.map((s, i) => ({
    company: WORKDAY_TENANTS[i].company,
    // Already location-filtered inside fetchTenant, before the detail budget.
    jobs: s.status === 'fulfilled' ? s.value : [],
  }));
}
