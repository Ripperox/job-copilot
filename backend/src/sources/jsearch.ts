import { Job, Profile } from '../types';
import { Config } from '../config';

// JSearch (RapidAPI) v5 — aggregates Google for Jobs (LinkedIn, Indeed, Glassdoor…).
// Searches each of the candidate's roles and de-dupes for broader coverage.
export async function fetchJSearchJobs(profile: Profile, config: Config): Promise<Job[]> {
  const location = profile.locations.find((l) => l.toLowerCase() !== 'remote') || 'India';
  const country = (config.adzunaCountry || 'in').toLowerCase();
  const pages = Math.max(1, config.jsearchPages || 1);
  const roles = (profile.roles.length ? profile.roles : ['software engineer']).slice(0, 3);

  const byId = new Map<string, Job>();
  for (const role of roles) {
    const query = encodeURIComponent(`${role} in ${location}`);
    const url = `https://jsearch.p.rapidapi.com/search-v2?query=${query}&num_pages=${pages}&country=${country}&date_posted=month`;
    try {
      const resp = await fetch(url, {
        headers: {
          'x-rapidapi-key': config.jsearchApiKey,
          'x-rapidapi-host': 'jsearch.p.rapidapi.com',
        },
      });
      if (!resp.ok) {
        console.error(`JSearch "${role}" ${resp.status}: ${await resp.text()}`);
        continue;
      }
      const data: any = await resp.json();
      for (const r of data?.data?.jobs || []) {
        const job = mapJob(r);
        byId.set(job.id, job);
      }
    } catch (e) {
      console.error(`JSearch "${role}" failed:`, e);
    }
  }
  return [...byId.values()];
}

function mapJob(r: any): Job {
  const loc = r.job_is_remote
    ? 'Remote'
    : r.job_location || [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', ');
  const salary = r.job_min_salary
    ? `${Math.round(r.job_min_salary)}${r.job_max_salary ? '–' + Math.round(r.job_max_salary) : ''} ${r.job_salary_currency || ''}`.trim()
    : null;
  return {
    id: `jsearch:${r.job_id}`,
    source: 'jsearch',
    title: r.job_title || '',
    company: r.employer_name || 'Unknown',
    location: loc,
    description: r.job_description || '',
    url: r.job_apply_link || '',
    salary,
    postedAt: r.job_posted_at_datetime_utc || null,
    createdAt: new Date().toISOString(),
  };
}
