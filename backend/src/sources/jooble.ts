import { Job, Profile } from '../types';
import { Config } from '../config';

// Jooble aggregator API (free key on request at https://jooble.org/api/about).
// Strong India coverage. POST { keywords, location } to /api/{key}.
export async function fetchJoobleJobs(profile: Profile, config: Config): Promise<Job[]> {
  const keywords = profile.roles.slice(0, 2).join(', ') || 'software engineer';
  const location = profile.locations.find((l) => l.toLowerCase() !== 'remote') || 'India';

  const resp = await fetch(`https://jooble.org/api/${config.joobleApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords, location }),
  });
  if (!resp.ok) throw new Error(`Jooble ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const now = new Date().toISOString();

  return (data.jobs || []).map((r: any): Job => ({
    id: `jooble:${r.id ?? r.link}`,
    source: 'jooble',
    title: r.title || '',
    company: r.company || 'Unknown',
    location: r.location || '',
    description: String(r.snippet || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    url: r.link || '',
    salary: r.salary || null,
    postedAt: r.updated || null,
    createdAt: now,
  }));
}
