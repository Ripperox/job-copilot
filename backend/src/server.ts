import express from 'express';
import cors from 'cors';
import { config } from './config';
import { db } from './db';
import { Job, Profile, ScoredJob, Outreach, JobMeta, JOB_STATUSES } from './types';
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

app.get('/api/profile', (_req, res) => {
  res.json(db.getProfile());
});

app.put('/api/profile', (req, res) => {
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
  res.json(db.setProfile(profile));
});

// Pull jobs from all sources, then score any that are new.
app.post('/api/fetch', async (_req, res) => {
  const profile = db.getProfile();
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });

  let sources: string[] = [];
  try {
    const gathered = await gatherJobs(profile, config);
    sources = gathered.sources;
    for (const job of gathered.jobs) db.upsertJob(job);
  } catch (e: any) {
    console.error('fetch failed:', e);
    return res.status(500).json({ error: 'Failed to fetch jobs', detail: e.message });
  }

  const toScore = db.unscoredJobs();
  let scored = 0;
  for (const job of toScore) {
    try {
      const r = await scoreJob(job, profile, config);
      db.setScore({ jobId: job.id, score: r.score, reason: r.reason, cvVariant: r.cvVariant, scoredAt: new Date().toISOString() });
      scored++;
    } catch (e) {
      console.error('scoring failed for', job.id, e);
    }
  }

  res.json({ sources, scored, total: db.allJobs().length });
});

function toScoredJob(job: Job): ScoredJob {
  const s = db.getScore(job.id);
  const m = db.getMeta(job.id);
  return {
    ...job,
    score: s?.score ?? null,
    reason: s?.reason ?? null,
    cvVariant: s?.cvVariant ?? null,
    status: m.status,
    notes: m.notes,
    dismissed: m.dismissed,
  };
}

// Re-score ALL jobs against the current profile. Useful after adding an LLM key
// or editing your profile (fetch only scores brand-new jobs).
app.post('/api/rescore', async (_req, res) => {
  const profile = db.getProfile();
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });
  let rescored = 0;
  for (const job of db.allJobs()) {
    try {
      const r = await scoreJob(job, profile, config);
      db.setScore({ jobId: job.id, score: r.score, reason: r.reason, cvVariant: r.cvVariant, scoredAt: new Date().toISOString() });
      rescored++;
    } catch (e) {
      console.error('rescore failed for', job.id, e);
    }
  }
  res.json({ rescored });
});

// List scored jobs, filtered by minimum score, best first. Dismissed jobs are
// hidden unless ?includeDismissed=true.
app.get('/api/jobs', (req, res) => {
  const minScore = Number(req.query.minScore) || 0;
  const includeDismissed = req.query.includeDismissed === 'true';
  const jobs: ScoredJob[] = db
    .allJobs()
    .map(toScoredJob)
    .filter((j) => (j.score ?? 0) >= minScore)
    .filter((j) => includeDismissed || !j.dismissed)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  res.json(jobs);
});

// Update a job's pipeline status, notes, or dismissed flag.
app.patch('/api/jobs/:id', (req, res) => {
  const id = req.params.id;
  const job = db.allJobs().find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: 'not found' });

  const patch: Partial<JobMeta> = {};
  if (typeof req.body?.status === 'string' && JOB_STATUSES.includes(req.body.status)) {
    patch.status = req.body.status;
  }
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;
  if (typeof req.body?.dismissed === 'boolean') patch.dismissed = req.body.dismissed;
  if (Object.keys(patch).length) db.setMeta(id, patch);

  res.json(toScoredJob(job));
});

// Cached outreach for a job (null if not generated yet).
app.get('/api/jobs/:id/outreach', (req, res) => {
  res.json(db.getOutreach(req.params.id) ?? null);
});

// Generate (or regenerate) the outreach draft for a job: a referral message,
// an application note, and who to contact. Cached until ?regenerate=true.
app.post('/api/jobs/:id/outreach', async (req, res) => {
  const job = db.allJobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const profile = db.getProfile();
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });

  const regenerate = req.query.regenerate === 'true';
  const cached = db.getOutreach(job.id);
  if (cached && !regenerate) return res.json(cached);

  try {
    const content = await generateOutreach(job, profile, config);
    const score = db.getScore(job.id);
    const outreach: Outreach = {
      jobId: job.id,
      referralMessage: content.referralMessage,
      applicationNote: content.applicationNote,
      targets: content.targets,
      cvVariant: score?.cvVariant ?? profile.cvVariants[0] ?? 'Default',
      generatedAt: new Date().toISOString(),
    };
    db.setOutreach(outreach);
    res.json(outreach);
  } catch (e: any) {
    console.error('outreach failed:', e);
    res.status(500).json({ error: 'Failed to generate outreach', detail: e.message });
  }
});

app.listen(config.port, () => console.log(`Job Copilot API on http://localhost:${config.port}`));

export default app;
