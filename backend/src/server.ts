import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import { config, authConfigured } from './config';
import { db, LOCAL_USER_ID } from './db';
import { query, closePool } from './db/pool';
import { applySchema } from './db/migrate';
import { Job, Profile, Outreach, JobMeta, JOB_STATUSES } from './types';
import { gatherJobs } from './sources';
import { scoreJob } from './scoring';
import { scoreJobsBatched } from './batch-scoring';
import { generateOutreach } from './outreach';
import { llmProvider, llmComplete, isRateLimit } from './llm';
import { encryptSecret, maskKey } from './crypto';
import { llmConfigForUser, detectProvider, configForKey } from './user-llm';
import { providerStatus } from './scrapers';
import { buildAuthUrl, exchangeCodeForIdentity } from './auth/google';
import { setSessionCookie, clearSessionCookie, sessionCookieOptions } from './auth/session';
import { attachUser, requireAuth } from './auth/middleware';

const app = express();
// Hosts like Render/Fly terminate TLS at their proxy and forward plain HTTP.
// Without this, Express sees an insecure connection and refuses to set Secure
// cookies, which silently breaks sign-in in production.
if (config.isProduction) app.set('trust proxy', 1);
// Cookies need an explicit origin and credentials:true — a wildcard origin would
// make the browser drop the session cookie.
app.use(cors({ origin: config.frontendOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

// Render polls this as the health check, so it must actually prove the process
// is usable — a server that booted but cannot reach Postgres is not healthy.
app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch (e) {
    console.error('health: database unreachable', e);
  }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk,
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
  // These must survive Google's cross-site redirect back to the callback, so in
  // production they need the same None+Secure treatment as the session cookie.
  const shortLived = { ...sessionCookieOptions(config), maxAge: 10 * 60 * 1000 };
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

// ------------------------------------------------------------- the free demo

// One pre-scored job, identical for everyone, cached at seed time. Open to
// signed-out visitors so the product proves itself before anyone adds a key.
// Operator LLM cost is paid once, not per signup.
app.get('/api/demo', async (_req, res) => {
  const job = await db.getDemoJob();
  if (!job) return res.json(null);
  res.json(job);
});

// --------------------------------------------------------- bring-your-own-key

// Reports only whether a key exists and a mask of it — never the key itself.
app.get('/api/key', requireAuth, async (req, res) => {
  const record = await db.getUserKeyRecord(req.userId!);
  res.json({
    hasKey: Boolean(record),
    mask: record?.mask ?? null,
    provider: record?.provider ?? null,
  });
});

// The provider is inferred from the key's prefix, then the key is validated with
// a real call before storage — a typo surfaces here rather than as silently
// heuristic scores later.
app.put('/api/key', requireAuth, async (req, res) => {
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim()
    : typeof req.body?.geminiApiKey === 'string' ? req.body.geminiApiKey.trim()
    : '';
  if (!key) return res.status(400).json({ error: 'An API key is required.' });
  if (!config.keyEncryptionSecret) {
    return res.status(503).json({ error: 'Server cannot store keys: KEY_ENCRYPTION_SECRET is not set.' });
  }

  const provider = detectProvider(key);
  let warning: string | undefined;
  try {
    await llmComplete('Reply with OK.', configForKey(config, provider, key), 16);
  } catch (e: unknown) {
    // A 429 means the key is VALID but out of quota right now — rejecting it
    // would lock out anyone whose free tier is momentarily exhausted. Store it
    // and warn instead. Only auth-shaped failures mean the key is actually bad.
    if (isRateLimit(e)) {
      warning = `${provider} accepted the key but is rate-limited right now, so scoring may fall back to keywords until quota resets.`;
    } else {
      return res.status(400).json({
        error: `That key was rejected by ${provider}.`,
        detail: String((e as Error).message).slice(0, 200),
      });
    }
  }

  await db.setUserKey(req.userId!, encryptSecret(key, config.keyEncryptionSecret), maskKey(key), provider);
  res.json({ hasKey: true, mask: maskKey(key), provider, warning });
});

app.delete('/api/key', requireAuth, async (req, res) => {
  await db.deleteUserKey(req.userId!);
  res.json({ hasKey: false, mask: null, provider: null });
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
// against that user's resume.
//
// The lock is therefore PER USER, not global. It was one shared boolean, which
// meant any user's fetch — or a scheduler tick walking every account — returned
// "a fetch is already in progress" to everybody else. Fine with one user, wrong
// the moment a second signs up.
const fetching = new Set<string>();

interface FetchResult {
  sources: string[];
  added: number;
  scored: number;
  total: number;
  usedLLM: boolean;
}

// Scores a set of jobs in as few LLM requests as possible and persists them.
// scoreJobsBatched guarantees a result for every job, so the only thing that can
// go wrong here is the database write.
async function scoreAndStore(
  userId: string,
  jobs: Job[],
  profile: Profile,
  llm: typeof config,
): Promise<number> {
  if (!jobs.length) return 0;

  const outcome = await scoreJobsBatched(jobs, profile, llm);
  const scoredAt = new Date().toISOString();
  let written = 0;

  for (const [jobId, r] of outcome.results) {
    try {
      await db.setScore(userId, {
        jobId, score: r.score, reason: r.reason, cvVariant: r.cvVariant, scoredAt,
      });
      written++;
    } catch (e) {
      console.error('could not store score for', jobId, e);
    }
  }

  console.log(
    `[scoring] user=${userId.slice(0, 8)} jobs=${jobs.length} ` +
    `gated=${outcome.gated} batched=${outcome.batched} individual=${outcome.individual} ` +
    `heuristic=${outcome.heuristic} llmRequests=${outcome.llmRequests}`,
  );
  return written;
}

async function runFetchForUser(userId: string): Promise<FetchResult> {
  const profile = await db.getProfile(userId);
  if (!profile) throw new Error('Set your profile first.');

  // Job-source calls run on the OPERATOR's keys — the pool is shared, so it is
  // fetched once for everyone rather than once per user.
  const gathered = await gatherJobs(profile, config);
  let added = 0;
  for (const job of gathered.jobs) if (await db.upsertJob(job)) added++;

  // Scoring runs on THIS user's own LLM key. Without one it degrades to the
  // keyword heuristic rather than spending the operator's quota.
  const { config: llm, hasKey } = await llmConfigForUser(userId, config);

  const toScore = await db.unscoredJobs(userId);
  const scored = await scoreAndStore(userId, toScore, profile, llm);

  return { sources: gathered.sources, added, scored, total: (await db.allJobs()).length, usedLLM: hasKey };
}

app.post('/api/fetch', async (req, res) => {
  const userId = req.userId!;
  if (fetching.has(userId)) return res.status(409).json({ error: 'A fetch is already in progress.' });
  fetching.add(userId);
  try {
    const result = await runFetchForUser(userId);
    res.json(result);
  } catch (e: any) {
    console.error('fetch failed:', e);
    res.status(500).json({ error: 'Failed to fetch jobs', detail: e.message });
  } finally {
    fetching.delete(userId);
  }
});

// Re-score ALL jobs against the current profile. Useful after adding an LLM key
// or editing your profile (fetch only scores brand-new jobs).
app.post('/api/rescore', async (req, res) => {
  const profile = await db.getProfile(req.userId!);
  if (!profile) return res.status(400).json({ error: 'Set your profile first.' });
  const { config: llm, hasKey } = await llmConfigForUser(req.userId!, config);
  const rescored = await scoreAndStore(req.userId!, await db.allJobs(), profile, llm);
  res.json({ rescored, usedLLM: hasKey });
});

// List scored jobs, filtered by minimum score, best first (SQL does the sort).
// Dismissed jobs are hidden unless ?includeDismissed=true.
app.get('/api/jobs', async (req, res) => {
  const minScore = Number(req.query.minScore) || 0;
  const includeDismissed = req.query.includeDismissed === 'true';
  // ?source=scraped powers the career-pages dashboard; omit for everything.
  const source = typeof req.query.source === 'string' ? req.query.source : '';
  const jobs = (await db.scoredJobs(req.userId!))
    .filter((j) => (j.score ?? 0) >= minScore)
    .filter((j) => includeDismissed || !j.dismissed)
    .filter((j) => !source || j.source === source);
  res.json(jobs);
});

// Which job sources currently have jobs in the pool, and how many. Drives the
// dashboard's source tabs.
app.get('/api/sources', requireAuth, async (_req, res) => {
  const counts = new Map<string, number>();
  for (const job of await db.allJobs()) counts.set(job.source, (counts.get(job.source) ?? 0) + 1);
  res.json({
    sources: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    scrapers: providerStatus(config),
    // A provider reporting "configured" is NOT enough to say scraping is on:
    // Jina needs no key, so it is always configured. With no URL list there is
    // nothing to read, and the UI has to say that instead of promising a
    // trickle of roles that can never arrive.
    careerPageCount: config.scrapeCareerPages.length,
  });
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
    // Drafting also spends the user's own LLM quota; without a key they get the
    // filled-in template instead.
    const { config: llm } = await llmConfigForUser(req.userId!, config);
    const content = await generateOutreach(job, profile, llm);
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
    try {
      const userIds = await db.usersWithProfiles();
      if (!userIds.length) {
        console.log('[scheduler] no users with a profile yet — nothing to fetch.');
        return;
      }
      for (const userId of userIds) {
        // Take only THIS user's lock, and skip them if they have a fetch of
        // their own running. A slow account must not stall everyone behind it,
        // and must never make another user's manual click return 409.
        if (fetching.has(userId)) {
          console.log(`[scheduler] user=${userId.slice(0, 8)} already fetching — skipping.`);
          continue;
        }
        fetching.add(userId);
        try {
          const r = await runFetchForUser(userId);
          console.log(`[scheduler] user=${userId.slice(0, 8)} sources=${r.sources.join(',') || 'none'} added=${r.added} scored=${r.scored} total=${r.total}`);
        } catch (e: any) {
          console.error(`[scheduler] fetch failed for user ${userId.slice(0, 8)}:`, e.message);
        } finally {
          fetching.delete(userId);
        }
      }
    } catch (e: any) {
      console.error('[scheduler] tick failed:', e.message);
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
  // Render sends SIGTERM on redeploy and scale-down. Close the pool so in-flight
  // queries finish and Postgres connections are released rather than leaked.
  const shutdown = (signal: string) => async () => {
    console.log(`${signal} received — closing database pool.`);
    try {
      await closePool();
    } catch (e) {
      console.error('error closing pool:', e);
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

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
