import { Job, Profile } from '../types';
import { Config } from '../config';
import { fetchMockJobs } from './mock';
import { fetchAdzunaJobs } from './adzuna';
import { fetchGreenhouseJobs } from './greenhouse';
import { fetchLeverJobs } from './lever';
import { fetchJSearchJobs } from './jsearch';
import { fetchJoobleJobs } from './jooble';
import { fetchFantasticJobs } from './fantastic';
import { fetchScrapedJobs } from './scraped';

// Aggregates all configured job sources. Falls back to the mock set so the app
// is usable with zero API keys. New sources (Greenhouse, Lever, ...) plug in here.
export async function gatherJobs(profile: Profile, config: Config): Promise<{ jobs: Job[]; sources: string[] }> {
  const jobs: Job[] = [];
  const sources: string[] = [];
  let gotReal = false;

  if (config.adzunaAppId && config.adzunaAppKey) {
    try {
      const a = await fetchAdzunaJobs(profile, config);
      jobs.push(...a);
      sources.push(`adzuna(${a.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Adzuna source failed:', e);
    }
  }

  if (config.greenhouseBoards.length > 0) {
    try {
      const g = await fetchGreenhouseJobs(config.greenhouseBoards);
      jobs.push(...g);
      sources.push(`greenhouse(${g.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Greenhouse source failed:', e);
    }
  }

  if (config.leverBoards.length > 0) {
    try {
      const l = await fetchLeverJobs(config.leverBoards);
      jobs.push(...l);
      sources.push(`lever(${l.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Lever source failed:', e);
    }
  }

  if (config.jsearchApiKey) {
    try {
      const j = await fetchJSearchJobs(profile, config);
      jobs.push(...j);
      sources.push(`jsearch(${j.length})`);
      gotReal = true;
    } catch (e) {
      console.error('JSearch source failed:', e);
    }
  }

  if (config.joobleApiKey) {
    try {
      const j = await fetchJoobleJobs(profile, config);
      jobs.push(...j);
      sources.push(`jooble(${j.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Jooble source failed:', e);
    }
  }

  if (config.activeJobsApiKey) {
    try {
      const a = await fetchFantasticJobs(
        { host: 'active-jobs-db.p.rapidapi.com', path: '/active-ats', label: 'activejobs', apiKey: config.activeJobsApiKey },
        profile,
        config,
      );
      jobs.push(...a);
      sources.push(`activejobs(${a.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Active Jobs DB source failed:', e);
    }
  }

  if (config.linkedinJobsApiKey) {
    try {
      const l = await fetchFantasticJobs(
        { host: 'linkedin-job-search-api.p.rapidapi.com', path: '/active-jb', label: 'linkedin', apiKey: config.linkedinJobsApiKey },
        profile,
        config,
      );
      jobs.push(...l);
      sources.push(`linkedin(${l.length})`);
      gotReal = true;
    } catch (e) {
      console.error('LinkedIn Jobs source failed:', e);
    }
  }

  // Company career pages. Unlike the aggregators above, these carry roles that
  // are earlier and far less competed — often before they syndicate anywhere.
  if (config.scrapeCareerPages.length > 0) {
    try {
      const s = await fetchScrapedJobs(profile, config);
      jobs.push(...s);
      sources.push(`scraped(${s.length})`);
      gotReal = true;
    } catch (e) {
      console.error('Scraped career pages failed:', e);
    }
  }

  if (!gotReal || jobs.length === 0) {
    const m = fetchMockJobs();
    jobs.push(...m);
    sources.push(`mock(${m.length})`);
  }

  return { jobs, sources };
}
