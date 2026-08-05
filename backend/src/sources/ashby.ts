import { Job } from '../types';
import { filterOpenToIndia, companyFromToken } from './ats-filter';

// Ashby public job-board API (no key required).
// Endpoint: https://api.ashbyhq.com/posting-api/job-board/{token}
//
// Added because Ashby is where a lot of the remote-friendly companies now post
// — Supabase, Linear, Railway, Neon, SentiLink, Atlan, Navi — and none of them
// appear on the Greenhouse or Lever boards we already read.

interface AshbyPosting {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  jobUrl?: string;
  applyUrl?: string;
  isListed?: boolean;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBoard(token: string): Promise<Job[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Ashby ${token} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data: any = await resp.json();
  const now = new Date().toISOString();
  const company = companyFromToken(token);

  return (data.jobs || [])
    .filter((p: AshbyPosting) => p.isListed !== false)
    .map((p: AshbyPosting): Job => {
      // Ashby reports remote as a flag rather than in the location string, so
      // fold it in — otherwise a genuinely remote role reads as office-only and
      // gets dropped by the location gate.
      const base = p.location || '';
      const location = p.isRemote && !/remote/i.test(base) ? (base ? `Remote, ${base}` : 'Remote') : base;
      return {
        id: `ashby:${token}:${p.id ?? p.jobUrl ?? p.title}`,
        source: 'ashby',
        title: p.title || '',
        company,
        location,
        description: p.descriptionPlain
          ? String(p.descriptionPlain)
          : p.descriptionHtml
            ? stripHtml(String(p.descriptionHtml))
            : '',
        url: p.jobUrl || p.applyUrl || '',
        salary: null,
        postedAt: p.publishedAt ?? null,
        createdAt: now,
      };
    });
}

export async function fetchAshbyJobs(boards: string[]): Promise<Job[]> {
  const results = await Promise.all(
    boards.map(async (token) => {
      try {
        return await fetchBoard(token);
      } catch (e) {
        // One dead board must never fail the whole source.
        console.error(`Ashby board "${token}" failed:`, String((e as Error)?.message ?? e).slice(0, 160));
        return [] as Job[];
      }
    }),
  );
  return filterOpenToIndia(results.flat());
}
