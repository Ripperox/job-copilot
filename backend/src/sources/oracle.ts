import { Job } from '../types';
import { filterEngineering, filterOpenToIndia } from './ats-filter';
import { pooled } from './pool';

// Oracle Recruiting Cloud — the ATS Oracle runs its own hiring on.
//
// careers.oracle.com is a shell around a public REST endpoint that needs no key:
//
//   GET https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/
//       recruitingCEJobRequisitions
//       ?onlyData=true
//       &expand=requisitionList.secondaryLocations
//       &finder=findReqs;siteNumber=CX_45001,limit=200,offset=0,
//               sortBy=POSTING_DATES_DESC,keyword=...
//
// Two things that cost time if you meet them cold:
//
//   1. `expand=requisitionList...` is not optional. Without it the response is
//      the facet/filter metadata and `requisitionList` is simply absent — it
//      reads like an empty result rather than a malformed request.
//   2. The finder arguments are semicolon-then-comma delimited INSIDE one query
//      parameter. They are not ordinary query params and must not be
//      URL-encoded away.
//
// The site number (CX_45001) identifies Oracle's own external careers site. It
// is read off careers.oracle.com and is not guessable; a different Oracle
// Recruiting Cloud customer has a different one on a different pod host.
//
// Verified live 2026-08-12: 1,556 postings matching "engineer", Bengaluru roles
// posted the same day.

// Oracle Recruiting Cloud is a product, not just Oracle's own board. Every
// customer runs it on their own Fusion host with their own site number, and
// large banks in particular are all over it. So this is a tenant table rather
// than a single hardcoded endpoint.
//
// Neither the host nor the site number is guessable — both are read off the
// employer's careers page. Each entry below was verified live on 2026-08-12 by
// calling its finder and reading back TotalJobsCount.
interface OracleTenant {
  company: string;
  /** Fusion host, no scheme. Differs per customer and per Oracle data centre. */
  host: string;
  /** The external careers site id, e.g. CX_1. Not the site's display name. */
  site: string;
}

export const ORACLE_TENANTS: OracleTenant[] = [
  { company: 'Oracle', host: 'eeho.fa.us2.oraclecloud.com', site: process.env.ORACLE_SITE_NUMBER || 'CX_45001' }, // 1556
  { company: 'JPMorgan Chase', host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' }, // 7339
  { company: 'BNY', host: 'eofe.fa.us2.oraclecloud.com', site: 'CX_1' }, // 1441
  { company: 'Uber', host: 'iaziqy.fa.ocs.oraclecloud.com', site: 'CX_1' }, // 667
  { company: 'Dell Technologies', host: 'enterpriseplatform.dell.com', site: 'CX_1001' }, // 378
  { company: 'Honeywell', host: 'ibqbjb.fa.ocs.oraclecloud.com', site: 'CX_1' }, // 1292
];

const UA = 'Mozilla/5.0 (compatible; Shortlist/1.0)';
const TIMEOUT_MS = 30_000;

// Oracle's search is keyword-driven with no "all engineering roles" facet, so
// coverage comes from asking several times. These overlap heavily on purpose —
// deduplication by requisition id is cheap, a missed posting is not. "developer"
// is here because a keyword search for "engineer" does not match it, which is
// how you quietly lose half of an Indian software org.
const KEYWORDS = ['software engineer', 'backend', 'developer', 'platform engineer', 'python'];

// Oracle honours limit=200; asking for more is silently clamped.
const PAGE = 200;

// Ceiling on full-description fetches per run, and how many run at once. The
// search results carry only ShortDescriptionStr — real prose, but sometimes as
// little as 70 characters, which gives the scorer almost nothing to work with
// beyond the title. The detail endpoint returns the whole posting. It costs one
// request per requisition, so it is bounded and applied only to what survives
// filtering.
const DETAIL_BUDGET = 100;
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
 * The full posting body for one requisition.
 *
 * Note the quotes inside the finder: `ById;Id="340778"` — the id is a quoted
 * string, and without the quotes the endpoint returns an empty item list rather
 * than an error, which looks exactly like a job that has been taken down.
 */
async function detail(t: OracleTenant, id: string): Promise<string | null> {
  try {
    const d = await getJson(
      `https://${t.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
        `?onlyData=true&expand=all&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${t.site}`,
    );
    const body = d?.items?.[0]?.ExternalDescriptionStr;
    return body ? stripHtml(body) : null;
  } catch {
    return null;
  }
}

async function search(t: OracleTenant, keyword: string): Promise<any[]> {
  const finder = [
    `findReqs;siteNumber=${t.site}`,
    'limit=' + PAGE,
    'offset=0',
    'sortBy=POSTING_DATES_DESC',
    `keyword=${encodeURIComponent(keyword)}`,
  ].join(',');
  const url =
    `https://${t.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`;

  const data = await getJson(url);
  return data?.items?.[0]?.requisitionList ?? [];
}

/**
 * A public link to one requisition.
 *
 * Oracle's own careers site has a vanity domain; every other tenant is served
 * from the generic Candidate Experience path on their Fusion host. Sending a
 * user to the wrong one gives them a 404 on a job that exists.
 */
function jobUrl(t: OracleTenant, id: string): string {
  return t.company === 'Oracle'
    ? `https://careers.oracle.com/jobs/#en/sites/jobsearch/job/${id}`
    : `https://${t.host}/hcmUI/CandidateExperience/en/sites/${t.site}/job/${id}`;
}

async function fetchTenant(t: OracleTenant): Promise<Job[]> {
  const settled = await Promise.allSettled(KEYWORDS.map((k) => search(t, k)));
  const now = new Date().toISOString();

  const seen = new Set<string>();
  const jobs: Job[] = [];

  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value) {
      const id = String(r?.Id ?? '');
      if (!id || !r?.Title || seen.has(id)) continue;
      seen.add(id);

      // Oracle posts one requisition against many offices. Keeping the
      // secondaries matters here specifically: plenty of roles read
      // "United States" as primary and carry Bengaluru or Hyderabad as a
      // secondary, and dropping them would filter out exactly the India
      // openings this source was added for.
      const locations = [
        r.PrimaryLocation,
        ...(r.secondaryLocations ?? []).map((l: any) => l?.Name),
      ].filter(Boolean);

      jobs.push({
        // Requisition ids are only unique within a tenant, so the tenant is part
        // of the key. Without it JPMorgan and BNY would collide on small ids.
        id: `oracle:${t.company.toLowerCase().replace(/\s+/g, '')}:${id}`,
        source: 'oracle',
        title: String(r.Title),
        company: t.company,
        location: locations.join('; '),
        // The list carries only a short blurb; the full posting needs a request
        // per requisition and there are well over a thousand. The blurb plus the
        // title is enough for the scorer to rank on, which is what this is for.
        description: String(r.ShortDescriptionStr ?? ''),
        url: jobUrl(t, id),
        salary: null,
        postedAt: r.PostedDate ? new Date(r.PostedDate).toISOString() : null,
        createdAt: now,
      });
    }
  }

  // Filter first, then enrich. Running the detail pass before filtering would
  // spend most of the budget on postings that are about to be discarded.
  const kept = filterOpenToIndia(filterEngineering(jobs));

  const wanted = kept.slice(0, DETAIL_BUDGET);
  const bodies = await pooled(
    wanted.map((j) => () => detail(t, j.id.slice(j.id.lastIndexOf(':') + 1))),
    DETAIL_CONCURRENCY,
  );
  // Keep the blurb where the detail call came back empty — a short description
  // still scores better than none.
  wanted.forEach((j, i) => {
    if (bodies[i]) j.description = bodies[i] as string;
  });

  return kept;
}

export interface OracleResult { company: string; jobs: Job[]; }

/**
 * Fetch every configured Oracle Recruiting tenant concurrently.
 *
 * Per-tenant results, matching workday.ts and boards.ts, so a customer that
 * renames a site or moves data centre shows as zero in the health panel rather
 * than disappearing into a total.
 */
export async function fetchOracleJobs(): Promise<OracleResult[]> {
  const settled = await Promise.allSettled(ORACLE_TENANTS.map(fetchTenant));
  return settled.map((s, i) => ({
    company: ORACLE_TENANTS[i].company,
    jobs: s.status === 'fulfilled' ? s.value : [],
  }));
}
