import { Job } from '../types';
import { filterOpenToIndia, companyFromToken } from './ats-filter';

// Greenhouse public job-board API (no key required).
// Docs: https://developers.greenhouse.io/job-board.html
// Endpoint: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true

// Strip HTML tags and collapse whitespace. Greenhouse `content` is HTML-escaped,
// so we also decode the handful of common entities before stripping tags.
function stripHtml(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBoard(token: string): Promise<Job[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Greenhouse ${token} ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const now = new Date().toISOString();

  return (data.jobs || []).map(
    (job: any): Job => ({
      id: `greenhouse:${token}:${job.id}`,
      source: 'greenhouse',
      title: job.title || '',
      // NOT departments[0].name — that is the team, so every GitLab role
      // came through as a company called "Engineering". The board API does
      // not carry a company name, so derive it from the token.
      company: companyFromToken(token),
      location: job.location?.name || '',
      description: job.content ? stripHtml(String(job.content)) : '',
      url: job.absolute_url || '',
      salary: null,
      postedAt: job.updated_at || null,
      createdAt: now,
    }),
  );
}

export async function fetchGreenhouseJobs(boards: string[]): Promise<Job[]> {
  const results = await Promise.all(
    boards.map(async (token) => {
      try {
        return await fetchBoard(token);
      } catch (e) {
        console.error(`Greenhouse board "${token}" failed:`, e);
        return [] as Job[];
      }
    }),
  );
  return filterOpenToIndia(results.flat());
}
