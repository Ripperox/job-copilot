import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import { config, authConfigured } from './config';
import { db, LOCAL_USER_ID } from './db';
import { applySchema } from './db/migrate';
import { Profile, Outreach, JobMeta, JOB_STATUSES } from './types';
import { gatherJobs } from './sources';
import { scoreJob } from './scoring';
import { generateOutreach } from './outreach';
import { llmProvider } from './llm';
import { buildAuthUrl, exchangeCodeForIdentity } from './auth/google';
import { setSessionCookie, clearSessionCookie } from './auth/session';
import { attachUser, requireAuth } from './auth/middleware';

const app = express();
// Cookies need an explicit origin and credentials:true — a wildcard origin would
// make the browser drop the session cookie.
app.use(cors({ origin: config.frontendOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    llm: llmProvider(config),
    adzuna: Boolean(config.adzunaAppId && config.adzunaAppKey),
    auth: authConfigured(config),
  });
});

// ---------------------------------------------------------------- auth routes

const OAUTH_STATE_COOKIE = 'jc_oauth_state';
const OAUTH_RETURN_COOKIE = 'jc_oauth_return';

// Where to send the browser after sign-in. The frontend passes its own origin
// (its dev port moves around), but we only honour origins on the allowlist — an
// open redirect here would let an attacker bounce a fresh session anywhere.
function safeReturnOrigin(requested: unknown): string {
  const fallback = config.frontendOrigins[0] ?? '/';
  if (typeof requested !== 'string' || !requested) return fallback;
  return config.frontendOrigins.includes(requested) ? requested : fallback;
}

// Start sign-in: stash a random state in a short-lived cookie (CSRF defence) and
// bounce the browser to Google's consent screen.
app.get('/api/auth/google', (req, res) => {
  if (!authConfigured(config)) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const shortLived = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    maxAge: 10 * 60 * 1000,
    path: '/',
  };
  res.cookie(OAUTH_STATE_COOKIE, state, shortLived);
  res.cookie(OAUTH_RETURN_COOKIE, safeReturnOrigin(req.query.return), shortLived);
  res.redirect(buildAuthUrl(state, config));
});

// Google redirects here. Verify state, exchange the code, upsert the user, set the
// session cookie, then hand the browser back to the frontend.
app.get('/api/auth/google/callback', async (req, res) => {
  if (!authConfigured(config)) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }
  const frontend = safeReturnOrigin(req.cookies?.[OAUTH_RETURN_COOKIE]);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const expected = req.cookies?.[OAUTH_STATE_COOKIE];

  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
  res.clearCookie(OAUTH_RETURN_COOKIE, { path: '/' });

  if (!code) return res.redirect(`${frontend}/?auth=error`);
  if (!state || !expected || state !== expected) {
    return res.redirect(`${frontend}/?auth=state_mismatch`);
  }

  try {
    const identity = await exchangeCodeForIdentity(code, config);
    const user = await db.upsertGoogleUser(identity.googleSub, identity.email, identity.name);
    setSessionCookie(res, user.id, config);
    res.redirect(`${frontend}/?auth=ok`);
  } catch (e: any) {
    console.error('google callback failed:', e.message);
    res.redirect(`${frontend}/?auth=error`);
  }
});

// Who am I? 200 with the user when signed in, 401 otherwise.
app.get('/api/auth/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not signed in.' });
  const user = await db.getUser(req.userId);
  if (!user) {
    // The account was deleted but the cookie survived — clear it.
    clearSessionCookie(res, config);
    return res.status(401).json({ error: 'Not signed in.' });
  }
  res.json(user);
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res, config);
  res.json({ ok: true });
});

// Delete the account and every row belonging to it (ON DELETE CASCADE).
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  await db.deleteUser(req.userId!);
  clearSessionCookie(res, config);
  res.json({ ok: true });
});

// Everything below this line requires a signed-in user.
app.use('/api/profile', requireAuth);
app.use('/api/jobs', requireAuth);
app.use('/api/fetch', requireAuth);
app.use('/api/rescore', requireAuth);

app.get('/api/profile', async (req, res) => {
  res.json(await db.getProfile(req.userId!));
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
  res.json(await db.setProfile(req.userId!, profile));
});

// Jobs are a SHARED pool, but the search queries and the scores are per-user: the
// sources are queried using a user's roles/locations, and every result is scored
// against that user's resume. A single in-flight lock stops a scheduled run and a
// manual click (or two ticks) from overlapping.
let fetching = false;

interface FetchResult {
  sources: string[];
  added: number;
  scored: number;
  total: number;
}

async function runFetchForUser(userId: string): Promise<FetchResult> {
  const profile = await db.getProfile(userId);
  if (!profile) throw new Error('Set your profile first.');

  // Results land in the shared jobs table, so one user's fetch widens the pool
  // for everyone; only the scores below are private to this user.
  const gathered = await gatherJobs(profile, config);
  let added = 0;
  for (const job of gathered.jobs) if (await db.upsertJob(job)) added++;

  const toScore = await db.unscoredJobs(userId);
  let scored = 0;
  for (const job of toScore) {
    try {
      const r = await scoreJob(job, profile, config);
      await db.setScore(userId, {
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

app.post('/api/fetch', async (req, res) => {
  if (fetching) return res.status(409).json({ error: 'A fetch is already in progress.' });
  fetching = true;
  try {
    const result = await runFetchForUser(req.userId!);
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
app.post('/api/rescore', async (req, res) => {
  const profile = await db.getProfile(req.userId!);
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });
  let rescored = 0;
  for (const job of await db.allJobs()) {
    try {
      const r = await scoreJob(job, profile, config);
      await db.setScore(req.userId!, {
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
  const jobs = (await db.scoredJobs(req.userId!))
    .filter((j) => (j.score ?? 0) >= minScore)
    .filter((j) => includeDismissed || !j.dismissed);
  res.json(jobs);
});

// Update a job's pipeline status, notes, or dismissed flag.
app.patch('/api/jobs/:id', async (req, res) => {
  const id = req.params.id;
  const existing = await db.getScoredJob(req.userId!, id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const patch: Partial<JobMeta> = {};
  if (typeof req.body?.status === 'string' && JOB_STATUSES.includes(req.body.status)) {
    patch.status = req.body.status;
  }
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;
  if (typeof req.body?.dismissed === 'boolean') patch.dismissed = req.body.dismissed;
  if (Object.keys(patch).length) await db.setMeta(req.userId!, id, patch);

  res.json(await db.getScoredJob(req.userId!, id));
});

// Cached outreach for a job (null if not generated yet).
app.get('/api/jobs/:id/outreach', async (req, res) => {
  res.json((await db.getOutreach(req.userId!, req.params.id)) ?? null);
});

// Generate (or regenerate) the outreach draft for a job: a referral message,
// an application note, and who to contact. Cached until ?regenerate=true.
app.post('/api/jobs/:id/outreach', async (req, res) => {
  const job = (await db.allJobs()).find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const profile = await db.getProfile(req.userId!);
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });

  const regenerate = req.query.regenerate === 'true';
  const cached = await db.getOutreach(req.userId!, job.id);
  if (cached && !regenerate) return res.json(cached);

  try {
    const content = await generateOutreach(job, profile, config);
    const score = await db.getScore(req.userId!, job.id);
    const outreach: Outreach = {
      jobId: job.id,
      referralMessage: content.referralMessage,
      applicationNote: content.applicationNote,
      targets: content.targets,
      cvVariant: score?.cvVariant ?? profile.cvVariants[0] ?? 'Default',
      generatedAt: new Date().toISOString(),
    };
    await db.setOutreach(req.userId!, outreach);
    res.json(outreach);
  } catch (e: any) {
    console.error('outreach failed:', e);
    res.status(500).json({ error: 'Failed to generate outreach', detail: e.message });
  }
});

// Auto-fetch scheduler: new postings roll in without anyone clicking "fetch".
// Runs once per user who has a profile — their roles drive the source queries and
// their resume drives the scores. Skips a tick if the previous run is still going.
// Set FETCH_INTERVAL_MINUTES=0 to disable.
//
// NOTE (revisit in Phase 4): scoring here spends the OPERATOR's LLM quota, so this
// loop is only affordable while the user count is small. Once users bring their own
// keys, scheduled scoring should use each user's key and be capped per tick.
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
      const userIds = await db.usersWithProfiles();
      if (!userIds.length) {
        console.log('[scheduler] no users with a profile yet — nothing to fetch.');
        return;
      }
      for (const userId of userIds) {
        try {
          const r = await runFetchForUser(userId);
          console.log(`[scheduler] user=${userId.slice(0, 8)} sources=${r.sources.join(',') || 'none'} added=${r.added} scored=${r.scored} total=${r.total}`);
        } catch (e: any) {
          console.error(`[scheduler] fetch failed for user ${userId.slice(0, 8)}:`, e.message);
        }
      }
    } catch (e: any) {
      console.error('[scheduler] tick failed:', e.message);
    } finally {
      fetching = false;
    }
  };
  setInterval(runScheduled, minutes * 60 * 1000);
  console.log(`Auto-fetch scheduler on: every ${minutes} min.`);
  // Kick off one run shortly after boot so the list is fresh on startup.
  setTimeout(runScheduled, 5000);
}

// Only bind a port when run directly (`tsx src/server.ts`). Tests import the app
// and drive it in-process, which must not start a listener or the scheduler.
if (require.main === module) {
  app.listen(config.port, async () => {
    console.log(`Job Copilot API on http://localhost:${config.port}`);
    try {
      await applySchema();
      // Keeps the pre-auth data's owner row alive until it is claimed by a real
      // account (see `npm run claim-local`).
      await db.ensureUser(LOCAL_USER_ID, 'local@jobcopilot', 'Local User');
      console.log(`Database ready. Google sign-in: ${authConfigured(config) ? 'enabled' : 'NOT configured'}`);
      startScheduler();
    } catch (e) {
      console.error('Database setup failed — scheduler not started:', e);
    }
  });
}

export default app;
