import { Job, Profile } from '../types';
import { Config } from '../config';

// Shared client for the Fantastic.jobs RapidAPI family — Active Jobs DB
// (/active-ats) and LinkedIn Job Search (/active-jb). Both return the same
// schema: an array of jobs sourced from company career sites / LinkedIn.
export interface FantasticSource {
  host: string; // e.g. active-jobs-db.p.rapidapi.com
  path: string; // e.g. /active-ats
  label: string; // Job.source value, e.g. 'activejobs'
  apiKey: string;
}

function buildTitleQuery(roles: string[]): string {
  const list = (roles.length ? roles : ['Software Engineer']).slice(0, 4);
  return list.map((r) => `"${r}"`).join(' OR ');
}

function buildLocationQuery(locations: string[]): string {
  const list = locations.length ? locations : ['India'];
  return list.slice(0, 3).map((l) => `"${l}"`).join(' OR ');
}

export async function fetchFantasticJobs(src: FantasticSource, profile: Profile, _config: Config): Promise<Job[]> {
  const title = buildTitleQuery(profile.roles);
  const location = buildLocationQuery(profile.locations);
  const url =
    `https://${src.host}${src.path}` +
    `?time_frame=7d&limit=50&offset=0&description_format=text` +
    `&title=${encodeURIComponent(title)}&location=${encodeURIComponent(location)}`;

  const resp = await fetch(url, {
    headers: { 'x-rapidapi-host': src.host, 'x-rapidapi-key': src.apiKey },
  });
  if (!resp.ok) throw new Error(`${src.label} ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  const arr: any[] = Array.isArray(data) ? data : data.data || data.jobs || [];
  return arr.map((r) => mapJob(r, src.label));
}

function mapJob(r: any, label: string): Job {
  const location =
    (Array.isArray(r.locations_derived) && r.locations_derived.join('; ')) ||
    (r.ai_work_arrangement === 'Remote' ? 'Remote' : '') ||
    (Array.isArray(r.cities_derived) && r.cities_derived.join(', ')) ||
    '';
  const salary = r.ai_salary_min_value
    ? `${r.ai_salary_min_value}${r.ai_salary_max_value ? '–' + r.ai_salary_max_value : ''} ${r.ai_salary_currency || ''} ${r.ai_salary_unit_text || ''}`.trim()
    : r.salary
      ? String(r.salary)
      : null;
  return {
    id: `${label}:${r.id}`,
    source: label,
    title: r.title || '',
    company: r.organization || 'Unknown',
    location: location || 'India',
    description: r.description_text || r.ai_requirements_summary || '',
    url: r.url || '',
    salary,
    postedAt: r.date_posted || null,
    createdAt: new Date().toISOString(),
  };
}
