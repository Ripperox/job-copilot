import { Job, Profile } from '../types';
import { Config } from '../config';
import { fetchMockJobs } from './mock';
import { fetchAdzunaJobs } from './adzuna';
import { fetchGreenhouseJobs } from './greenhouse';
import { fetchLeverJobs } from './lever';
import { fetchAshbyJobs } from './ashby';
import { fetchJSearchJobs } from './jsearch';
import { fetchJoobleJobs } from './jooble';
import { fetchFantasticJobs } from './fantastic';
import { fetchScrapedJobs } from './scraped';
import { fetchBoardJobs } from './boards';
import * as health from '../health';
import * as usage from '../usage';

// Aggregates all configured job sources. Falls back to the mock set so the app
// is usable with zero API keys. New sources (Greenhouse, Lever, ...) plug in here.
// Aggregates all configured job sources. Falls back to the mock set so the app
// is usable with zero API keys. New sources plug into TASKS below.
//
// Sources run CONCURRENTLY. They were awaited one after another, so a run took
// the SUM of every provider's latency — and the slowest, career-page scraping,
// can be a minute on its own while the ATS boards answer in under a second.
// They are independent network calls, so the wall clock should be the slowest
// one, not the total.
//
// allSettled, not all: one provider being rate-limited or down must never fail
// the others. Each task already catches internally; this is the belt to that
// bracer, and it keeps the partial results either way.
export async function gatherJobs(profile: Profile, config: Config): Promise<{ jobs: Job[]; sources: string[] }> {
  type Task = { label: string; run: () => Promise<Job[]> };
  const tasks: Task[] = [];

  if (config.adzunaAppId && config.adzunaAppKey) {
    tasks.push({ label: 'adzuna', run: () => fetchAdzunaJobs(profile, config) });
  }
  if (config.greenhouseBoards.length > 0) {
    tasks.push({ label: 'greenhouse', run: () => fetchGreenhouseJobs(config.greenhouseBoards) });
  }
  if (config.leverBoards.length > 0) {
    tasks.push({ label: 'lever', run: () => fetchLeverJobs(config.leverBoards) });
  }
  if (config.ashbyBoards.length > 0) {
    tasks.push({ label: 'ashby', run: () => fetchAshbyJobs(config.ashbyBoards) });
  }
  if (config.jsearchApiKey) {
    tasks.push({ label: 'jsearch', run: () => fetchJSearchJobs(profile, config) });
  }
  if (config.joobleApiKey) {
    tasks.push({ label: 'jooble', run: () => fetchJoobleJobs(profile, config) });
  }
  if (config.activeJobsApiKey) {
    tasks.push({
      label: 'activejobs',
      run: () => fetchFantasticJobs(
        { host: 'active-jobs-db.p.rapidapi.com', path: '/active-ats', label: 'activejobs', apiKey: config.activeJobsApiKey },
        profile, config,
      ),
    });
  }
  if (config.linkedinJobsApiKey) {
    tasks.push({
      label: 'linkedin',
      run: () => fetchFantasticJobs(
        { host: 'linkedin-job-search-api.p.rapidapi.com', path: '/active-jb', label: 'linkedin', apiKey: config.linkedinJobsApiKey },
        profile, config,
      ),
    });
  }
  // Free public remote boards — RemoteOK, Remotive, We Work Remotely. No keys,
  // no Firecrawl credits, ~340 jobs a run. Registered as one task that fans out
  // internally, then split back into per-board results so a board that goes
  // quiet is visible in the health panel rather than lost in a total.
  tasks.push({
    label: 'boards',
    run: async () => {
      const results = await fetchBoardJobs();
      for (const r of results) {
        void health.recordOk(r.source, 'job', r.jobs.length);
      }
      return results.flatMap((r) => r.jobs);
    },
  });

  // Company career pages. Unlike the aggregators above, these carry roles that
  // are earlier and far less competed — often before they syndicate anywhere.
  if (config.scrapeCareerPages.length > 0) {
    tasks.push({ label: 'scraped', run: () => fetchScrapedJobs(profile, config) });
  }

  const started = Date.now();
  // One call per source per run — counted whether it succeeds or not, because a
  // request that comes back 429 has still been spent against the plan.
  tasks.forEach((t) => void usage.bump(t.label));
  const settled = await Promise.allSettled(tasks.map((t) => t.run()));

  const jobs: Job[] = [];
  const sources: string[] = [];
  let gotReal = false;

  settled.forEach((outcome, i) => {
    const { label } = tasks[i];
    if (outcome.status === 'fulfilled') {
      jobs.push(...outcome.value);
      sources.push(`${label}(${outcome.value.length})`);
      gotReal = true;
      void health.recordOk(label, 'job', outcome.value.length);
    } else {
      const msg = String(outcome.reason?.message ?? outcome.reason).slice(0, 200);
      console.error(`${label} source failed:`, msg);
      // Surface it in the product, not just in stderr where nobody looks.
      void health.recordFailure(label, 'job', msg);
    }
  });
  console.log(`[sources] ${tasks.length} sources in parallel, ${jobs.length} jobs, ${Date.now() - started}ms`);

  if (!gotReal || jobs.length === 0) {
    const m = fetchMockJobs();
    jobs.push(...m);
    sources.push(`mock(${m.length})`);
  }

  return { jobs, sources };
}
