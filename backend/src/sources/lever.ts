import { Job } from '../types';
import { filterOpenToIndia } from './ats-filter';

// Lever public postings API (no key required).
// Endpoint: https://api.lever.co/v0/postings/{slug}?mode=json

// Strip HTML tags and collapse whitespace, used as a fallback when the
// plain-text description is missing.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchCompany(slug: string): Promise<Job[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Lever ${slug} ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const now = new Date().toISOString();

  return (Array.isArray(data) ? data : []).map((posting: any): Job => {
    const description =
      posting.descriptionPlain ||
      (posting.description ? stripHtml(String(posting.description)) : '');
    const postedAt =
      typeof posting.createdAt === 'number'
        ? new Date(posting.createdAt).toISOString()
        : null;

    return {
      id: `lever:${slug}:${posting.id}`,
      source: 'lever',
      title: posting.text || '',
      company: slug,
      location: posting.categories?.location || '',
      description,
      url: posting.hostedUrl || '',
      salary: null,
      postedAt,
      createdAt: now,
    };
  });
}

export async function fetchLeverJobs(companies: string[]): Promise<Job[]> {
  const results = await Promise.all(
    companies.map(async (slug) => {
      try {
        return await fetchCompany(slug);
      } catch (e) {
        console.error(`Lever company "${slug}" failed:`, e);
        return [] as Job[];
      }
    }),
  );
  return filterOpenToIndia(results.flat());
}
