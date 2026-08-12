import { Job } from '../types';
import { filterEngineering } from './ats-filter';

// MyNextHire — an Indian ATS that several large consumer companies run.
//
//   POST https://{company}.mynexthire.com/employer/careers/reqlist/get
//   content-type: application/json
//   {"source":"careers"}
//
// Returns every open requisition in one response, so there is no pagination and
// no detail pass: the list already carries the description.
//
// No location filter is applied in this module, unlike workday.ts and
// smartrecruiters.ts. These are Indian companies hiring into Indian offices, so
// filtering for India would mostly be a no-op, and their location strings are
// bare city names ("Bangalore", "Gurgaon") that the openToIndia regex handles
// inconsistently. Engineering-title filtering still runs.
//
// Verified live 2026-08-12: Swiggy 88 requisitions, ShareChat 8.

interface MnhCompany {
  /** Displayed as the employer. */
  company: string;
  /** Subdomain on mynexthire.com. */
  tenant: string;
}

export const MYNEXTHIRE_COMPANIES: MnhCompany[] = [
  { company: 'Swiggy', tenant: 'swiggy' }, // 88
  { company: 'ShareChat', tenant: 'sharechat' }, // 8
];

const UA = 'Mozilla/5.0 (compatible; Shortlist/1.0)';
const TIMEOUT_MS = 25_000;

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

/**
 * Pick the first field present out of several candidate names.
 *
 * MyNextHire is white-labelled per customer and the payload keys are not
 * consistent between tenants — Swiggy and ShareChat disagree on what the
 * location field is called. Reading a list of plausible names keeps one tenant's
 * schema drift from emptying a column for everyone.
 */
function pick(o: any, keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function fetchCompany(c: MnhCompany): Promise<Job[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let data: any;
  try {
    const r = await fetch(`https://${c.tenant}.mynexthire.com/employer/careers/reqlist/get`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({ source: 'careers' }),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    data = await r.json();
  } finally {
    clearTimeout(timer);
  }

  const now = new Date().toISOString();
  const reqs: any[] = data?.reqDetailsBOList ?? [];

  const jobs = reqs
    .map((r): Job | null => {
      const id = pick(r, ['reqId', 'requisitionId', 'id', 'jobId']);
      const title = pick(r, ['reqTitle', 'jobTitle', 'title', 'designation']);
      if (!id || !title) return null;

      const posted = pick(r, ['publishedDate', 'createdDate', 'postedDate']);
      const when = posted ? new Date(posted) : null;

      return {
        id: `mynexthire:${c.tenant}:${id}`,
        source: 'mynexthire',
        title,
        company: c.company,
        location: pick(r, ['location', 'jobLocation', 'locationName', 'city']),
        description: stripHtml(pick(r, ['jobDescription', 'description', 'reqDescription'])),
        url: `https://${c.tenant}.mynexthire.com/careers/job/${id}`,
        salary: null,
        postedAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
        createdAt: now,
      };
    })
    .filter((j): j is Job => j !== null);

  return filterEngineering(jobs);
}

export interface MyNextHireResult { company: string; jobs: Job[]; }

export async function fetchMyNextHireJobs(): Promise<MyNextHireResult[]> {
  const settled = await Promise.allSettled(MYNEXTHIRE_COMPANIES.map(fetchCompany));
  return settled.map((s, i) => ({
    company: MYNEXTHIRE_COMPANIES[i].company,
    jobs: s.status === 'fulfilled' ? s.value : [],
  }));
}
