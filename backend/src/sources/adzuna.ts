import { Job, Profile } from '../types';
import { Config } from '../config';

// Adzuna public job-search API (free tier). Requires ADZUNA_APP_ID + ADZUNA_APP_KEY.
// Docs: https://developer.adzuna.com/
export async function fetchAdzunaJobs(profile: Profile, config: Config): Promise<Job[]> {
  const what = encodeURIComponent(profile.roles[0] || 'software engineer');
  // "Remote" isn't a place Adzuna understands — use the first real location.
  const where = encodeURIComponent(profile.locations.find((l) => l.toLowerCase() !== 'remote') || '');
  const country = config.adzunaCountry || 'in';
  const url =
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1` +
    `?app_id=${config.adzunaAppId}&app_key=${config.adzunaAppKey}` +
    `&results_per_page=50&what=${what}${where ? `&where=${where}` : ''}` +
    `&content-type=application/json`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Adzuna ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const now = new Date().toISOString();

  return (data.results || []).map(
    (r: any): Job => ({
      id: `adzuna:${r.id}`,
      source: 'adzuna',
      title: r.title || '',
      company: r.company?.display_name || 'Unknown',
      location: r.location?.display_name || '',
      description: r.description || '',
      url: r.redirect_url || '',
      salary: r.salary_min ? `${Math.round(r.salary_min)}${r.salary_max ? '–' + Math.round(r.salary_max) : ''}` : null,
      postedAt: r.created || null,
      createdAt: now,
    }),
  );
}
