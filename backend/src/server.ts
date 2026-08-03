import express from 'express';
import cors from 'cors';
import { config } from './config';
import { db, LOCAL_USER_ID } from './db';
import { applySchema } from './db/migrate';
import { Profile, Outreach, JobMeta, JOB_STATUSES } from './types';
import { gatherJobs } from './sources';
import { scoreJob } from './scoring';
import { generateOutreach } from './outreach';
import { llmProvider } from './llm';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    llm: llmProvider(config),
    adzuna: Boolean(config.adzunaAppId && config.adzunaAppKey),
  });
});

app.get('/api/profile', async (_req, res) => {
  res.json(await db.getProfile(LOCAL_USER_ID));
});

app.put('/api/profile', async (req, res) => {
  const b = req.body ?? {};
  const profile: Profile = {
    resumeText: String(b.resumeText ?? ''),
    roles: Array.isArray(b.roles) ? b.roles : [],
    locations: Array.isArray(b.locations) ? b.locations : [],
    salaryFloorLPA: b.salaryFloorLPA == null ? null : Number(b.salaryFloorLPA),
    maxYoE: b.maxYoE == null ? 3 : Number(b.maxYoE),
    mustHaves: Array.isArray(b.mustHaves) ? b.mustHaves : [],
    cvVariants: Array.isArray(b.cvVariants) && b.cvVariants.length ? b.cvVariants : ['Backend', 'AI', 'Blockchain'],
  };
  res.json(await db.setProfile(LOCAL_USER_ID, profile));
});

// Pull jobs from all sources, then score any that are new. Shared by the manual
// POST /api/fetch endpoint and the hourly auto-fetch scheduler. A single in-flight
// lock prevents a scheduled run and a manual click (or two ticks) from overlapping.
let fetching = false;

interface FetchResult {
  sources: string[];
  added: number;
  scored: number;
  total: number;
}

async function runFetch(): Promise<FetchResult> {
  const profile = await db.getProfile(LOCAL_USER_ID);
  if (!profile) throw new Error('Set your profile first.');

  const gathered = await gatherJobs(profile, config);
  let added = 0;
  for (const job of gathered.jobs) if (await db.upsertJob(job)) added++;

  const toScore = await db.unscoredJobs(LOCAL_USER_ID);
  let scored = 0;
  for (const job of toScore) {
    try {
      const r = await scoreJob(job, profile, config);
      await db.setScore(LOCAL_USER_ID, {
        jobId: job.id, score: r.score, reason: r.reason,
        cvVariant: r.cvVariant, scoredAt: new Date().toISOString(),
      });
      scored++;
    } catch (e) {
      console.error('scoring failed for', job.id, e);
    }
  }

  return { sources: gathered.sources, added, scored, total: (await db.allJobs()).length };
}

app.post('/api/fetch', async (_req, res) => {
  if (fetching) return res.status(409).json({ error: 'A fetch is already in progress.' });
  fetching = true;
  try {
    const result = await runFetch();
    res.json(result);
  } catch (e: any) {
    console.error('fetch failed:', e);
    res.status(500).json({ error: 'Failed to fetch jobs', detail: e.message });
  } finally {
    fetching = false;
  }
});

// Re-score ALL jobs against the current profile. Useful after adding an LLM key
// or editing your profile (fetch only scores brand-new jobs).
app.post('/api/rescore', async (_req, res) => {
  const profile = await db.getProfile(LOCAL_USER_ID);
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });
  let rescored = 0;
  for (const job of await db.allJobs()) {
    try {
      const r = await scoreJob(job, profile, config);
      await db.setScore(LOCAL_USER_ID, {
        jobId: job.id, score: r.score, reason: r.reason,
        cvVariant: r.cvVariant, scoredAt: new Date().toISOString(),
      });
      rescored++;
    } catch (e) {
      console.error('rescore failed for', job.id, e);
    }
  }
  res.json({ rescored });
});

// List scored jobs, filtered by minimum score, best first (SQL does the sort).
// Dismissed jobs are hidden unless ?includeDismissed=true.
app.get('/api/jobs', async (req, res) => {
  const minScore = Number(req.query.minScore) || 0;
  const includeDismissed = req.query.includeDismissed === 'true';
  const jobs = (await db.scoredJobs(LOCAL_USER_ID))
    .filter((j) => (j.score ?? 0) >= minScore)
    .filter((j) => includeDismissed || !j.dismissed);
  res.json(jobs);
});

// Update a job's pipeline status, notes, or dismissed flag.
app.patch('/api/jobs/:id', async (req, res) => {
  const id = req.params.id;
  const existing = await db.getScoredJob(LOCAL_USER_ID, id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const patch: Partial<JobMeta> = {};
  if (typeof req.body?.status === 'string' && JOB_STATUSES.includes(req.body.status)) {
    patch.status = req.body.status;
  }
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;
  if (typeof req.body?.dismissed === 'boolean') patch.dismissed = req.body.dismissed;
  if (Object.keys(patch).length) await db.setMeta(LOCAL_USER_ID, id, patch);

  res.json(await db.getScoredJob(LOCAL_USER_ID, id));
});

// Cached outreach for a job (null if not generated yet).
app.get('/api/jobs/:id/outreach', async (req, res) => {
  res.json((await db.getOutreach(LOCAL_USER_ID, req.params.id)) ?? null);
});

// Generate (or regenerate) the outreach draft for a job: a referral message,
// an application note, and who to contact. Cached until ?regenerate=true.
app.post('/api/jobs/:id/outreach', async (req, res) => {
  const job = (await db.allJobs()).find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const profile = await db.getProfile(LOCAL_USER_ID);
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });

  const regenerate = req.query.regenerate === 'true';
  const cached = await db.getOutreach(LOCAL_USER_ID, job.id);
  if (cached && !regenerate) return res.json(cached);

  try {
    const content = await generateOutreach(job, profile, config);
    const score = await db.getScore(LOCAL_USER_ID, job.id);
    const outreach: Outreach = {
      jobId: job.id,
      referralMessage: content.referralMessage,
      applicationNote: content.applicationNote,
      targets: content.targets,
      cvVariant: score?.cvVariant ?? profile.cvVariants[0] ?? 'Default',
      generatedAt: new Date().toISOString(),
    };
    await db.setOutreach(LOCAL_USER_ID, outreach);
    res.json(outreach);
  } catch (e: any) {
    console.error('outreach failed:', e);
    res.status(500).json({ error: 'Failed to generate outreach', detail: e.message });
  }
});

// Auto-fetch scheduler: run runFetch() on a fixed interval so new postings roll in
// without anyone clicking "fetch". Skips a tick if the previous run is still going
// (a full fetch+score can take ~1 min). Set FETCH_INTERVAL_MINUTES=0 to disable.
function startScheduler(): void {
  const minutes = config.fetchIntervalMinutes;
  if (!minutes || minutes <= 0) {
    console.log('Auto-fetch scheduler disabled (FETCH_INTERVAL_MINUTES=0).');
    return;
  }
  const runScheduled = async () => {
    if (fetching) {
      console.log('[scheduler] previous fetch still running — skipping this tick.');
      return;
    }
    fetching = true;
    try {
      const r = await runFetch();
      console.log(`[scheduler] fetched: sources=${r.sources.join(',') || 'none'} added=${r.added} scored=${r.scored} total=${r.total}`);
    } catch (e: any) {
      console.error('[scheduler] fetch failed:', e.message);
    } finally {
      fetching = false;
    }
  };
  setInterval(runScheduled, minutes * 60 * 1000);
  console.log(`Auto-fetch scheduler on: every ${minutes} min.`);
  // Kick off one run shortly after boot so the list is fresh on startup.
  setTimeout(runScheduled, 5000);
}

app.listen(config.port, async () => {
  console.log(`Job Copilot API on http://localhost:${config.port}`);
  try {
    await applySchema();
    await db.ensureUser(LOCAL_USER_ID, 'local@jobcopilot', 'Local User');
    console.log('Database ready.');
    startScheduler();
  } catch (e) {
    console.error('Database setup failed — scheduler not started:', e);
  }
});

export default app;
