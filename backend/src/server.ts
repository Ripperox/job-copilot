import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
import * as health from './health';
import { llmProviderChain } from './llm';
import { buildAuthUrl, exchangeCodeForIdentity } from './auth/google';
import { setSessionCookie, clearSessionCookie, sessionCookieOptions } from './auth/session';
import { attachUser, requireAuth } from './auth/middleware';

const app = express();
// Hosts like Render/Fly terminate TLS at their proxy and forward plain HTTP.
// Without this, Express sees an insecure connection and refuses to set Secure
// cookies, which silently breaks sign-in in production.
if (config.isProduction) app.set('trust proxy', 1);

// Security headers. A black-box scan found none of these present and
// X-Powered-By announcing Express, which is free reconnaissance for anyone
// probing. CSP is off: this process serves JSON only, the frontend is on
// Vercel, and a policy here would protect nothing while being easy to get
// subtly wrong.
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // the SPA is a different origin
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  }),
);

// gzip/brotli. /api/jobs was measured at 7.71MB uncompressed; JSON this
// repetitive compresses by roughly 10x, and on a free-tier host bandwidth and
// time-to-first-byte are the constraint, not CPU.
app.use(compression());

// Cookies need an explicit origin and credentials:true — a wildcard origin would
// make the browser drop the session cookie.
app.use(
  cors({
    origin: config.frontendOrigins,
    credentials: true,
    // Without this the browser hides x-total-count from cross-origin JS, so the
    // client cannot tell a full page from a truncated one.
    exposedHeaders: ['x-total-count', 'x-request-id'],
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Correlation id on every request and its log lines, so a report of "it failed
// at 20:09" can be traced to one request instead of grepping by timestamp.
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || crypto.randomUUID().slice(0, 8);
  (req as express.Request & { id: string }).id = id;
  res.setHeader('x-request-id', id);
  const started = Date.now();
  res.on('finish', () => {
    // Only the slow and the failed — logging every 200 buries the signal.
    const ms = Date.now() - started;
    if (res.statusCode >= 400 || ms > 1000) {
      console.log(`[${id}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

app.use(attachUser);

// Rate limits, tightest where the work is most expensive. /fetch and /rescore
// each spend real money-equivalent quota (Firecrawl credits, LLM tokens), so a
// stuck retry loop or an impatient double-click must not be able to drain a
// day's budget in a minute.
const limit = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Per user when signed in, per IP otherwise — keying on IP alone would let
    // one office network exhaust everyone's allowance.
    keyGenerator: (req) => (req as express.Request & { userId?: string }).userId ?? ipKeyGenerator(req.ip ?? ""),
    message: { error: message },
  });

app.use('/api/', limit(60_000, 120, 'Too many requests. Wait a moment and try again.'));
app.use('/api/fetch', limit(10 * 60_000, 6, 'Fetches are limited to 6 per 10 minutes — each one spends scraping and model quota.'));
app.use('/api/rescore', limit(60 * 60_000, 4, 'Re-scoring is limited to 4 per hour — it re-reads every job in your pool.'));
app.use('/api/auth/google', limit(15 * 60_000, 20, 'Too many sign-in attempts. Try again shortly.'));

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
  const added = await db.upsertJobs(gathered.jobs);

  // Scoring runs on THIS user's own LLM key. Without one it degrades to the
  // keyword heuristic rather than spending the operator's quota.
  const { config: llm, hasKey } = await llmConfigForUser(userId, config);

  // Bounded: see config.maxScorePerRun. The remainder is picked up next tick,
  // which keeps a big import from eating the budget career-page extraction
  // needs — extraction produces jobs no other source has.
  const pending = await db.unscoredJobs(userId);
  const toScore = pending.slice(0, config.maxScorePerRun);
  if (pending.length > toScore.length) {
    console.log(`[score] ${pending.length} unscored; scoring ${toScore.length} this run, rest next tick`);
  }
  const scored = await scoreAndStore(userId, toScore, profile, llm);

  return { sources: gathered.sources, added, scored, total: await db.countJobs(), usedLLM: hasKey };
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

// List scored jobs, best first.
//
// Every filter is applied in SQL. This used to load the user's ENTIRE pool and
// filter in JavaScript: measured at 1,724 rows, a 6.5s query and a 7.71MB
// response, of which 85% was job descriptions the list view never renders.
// Descriptions are truncated to a snippet here; the full text comes from
// GET /api/jobs/:id when a card is opened.
app.get('/api/jobs', async (req, res) => {
  const n = (v: unknown, dflt: number, lo: number, hi: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.trunc(x))) : dflt;
  };
  const minScore = n(req.query.minScore, 0, 0, 100);
  const limit = n(req.query.limit, 200, 1, 500);
  const offset = n(req.query.offset, 0, 0, 1_000_000);
  const includeDismissed = req.query.includeDismissed === 'true';
  const source = typeof req.query.source === 'string' ? req.query.source.slice(0, 40) : '';

  const { jobs, total } = await db.listScoredJobs(req.userId!, {
    minScore, source, includeDismissed, limit, offset,
  });
  // Total is returned so the client can paginate without a second round trip.
  res.setHeader('x-total-count', String(total));
  res.json(jobs);
});

// Full record for one job, including the description the list omits.
app.get('/api/jobs/:id', async (req, res) => {
  const job = await db.getScoredJob(req.userId!, req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// Which job sources currently have jobs in the pool, and how many. Drives the
// dashboard's source tabs.
app.get('/api/sources', requireAuth, async (_req, res) => {
  res.json({
    sources: await db.countBySource(),
    scrapers: providerStatus(config),
    // A provider reporting "configured" is NOT enough to say scraping is on:
    // Jina needs no key, so it is always configured. With no URL list there is
    // nothing to read, and the UI has to say that instead of promising a
    // trickle of roles that can never arrive.
    careerPageCount: config.scrapeCareerPages.length,
  });
});

// Everything that can quietly stop working, in one place.
//
// Built after three job sources sat monthly-quota-dead for hours while the
// dashboard showed a healthy-looking pool of stale rows. Fetching, scoring and
// scraping all depend on third-party quotas that expire without warning, and
// none of that was visible anywhere except stderr.
app.get('/api/status', requireAuth, async (_req, res) => {
  const [recorded, counts, queue] = await Promise.all([
    health.all().catch(() => []),
    db.countBySource().catch(() => []),
    db.scrapeQueueStatus().catch(() => null),
  ]);

  const byName = new Map(recorded.map((h) => [h.name, h]));
  const countOf = (n: string) => counts.find((c) => c.name === n)?.count ?? 0;

  // Which sources COULD run, so a source that has never been configured is
  // distinguishable from one that is configured and broken.
  const jobSources = [
    { name: 'adzuna', configured: Boolean(config.adzunaAppId && config.adzunaAppKey) },
    { name: 'greenhouse', configured: config.greenhouseBoards.length > 0 },
    { name: 'lever', configured: config.leverBoards.length > 0 },
    { name: 'ashby', configured: config.ashbyBoards.length > 0 },
    { name: 'jsearch', configured: Boolean(config.jsearchApiKey) },
    { name: 'jooble', configured: Boolean(config.joobleApiKey) },
    { name: 'activejobs', configured: Boolean(config.activeJobsApiKey) },
    { name: 'linkedin', configured: Boolean(config.linkedinJobsApiKey) },
    { name: 'scraped', configured: config.scrapeCareerPages.length > 0 },
  ].map((s) => {
    const h = byName.get(s.name);
    return {
      ...s,
      state: !s.configured ? 'off' : (h?.state ?? 'idle'),
      detail: h?.detail ?? null,
      lastItems: h?.items ?? 0,
      inPool: countOf(s.name),
      checkedAt: h?.checkedAt ?? null,
      retryAfter: h?.retryAfter ?? null,
    };
  });

  const chain = llmProviderChain(config);
  const llm = (['groq', 'gemini', 'cerebras', 'anthropic'] as const).map((name) => {
    const h = byName.get(name);
    const configured = chain.includes(name);
    return {
      name,
      configured,
      // Position in the failover chain, so it is obvious which one is doing
      // the work and which are standing by.
      order: configured ? chain.indexOf(name) + 1 : null,
      state: !configured ? 'off' : (h?.state ?? 'idle'),
      detail: h?.detail ?? null,
      checkedAt: h?.checkedAt ?? null,
      retryAfter: h?.retryAfter ?? null,
    };
  });

  res.json({
    jobSources,
    llm,
    scrapers: providerStatus(config),
    queue,
    scrapeTargets: config.scrapeCareerPages.length,
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
  const job = await db.getJob(req.params.id);
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
    console.log(`Shortlist API on http://localhost:${config.port}`);
    try {
      await applySchema();
      // Keeps the pre-auth data's owner row alive until it is claimed by a real
      // account (see `npm run claim-local`).
      await db.ensureUser(LOCAL_USER_ID, 'local@jobcopilot', 'Local User');
  // Register the career-page targets. Idempotent: existing rows keep their
  // history, new urls join the back of the queue, and urls dropped from the
  // list are disabled rather than deleted so their record survives.
  const q = await db.syncScrapeTargets(config.scrapeCareerPages).catch((e) => {
    console.error('could not sync scrape targets:', e.message);
    return null;
  });
  if (q) {
    const st = await db.scrapeQueueStatus().catch(() => null);
    if (st) console.log(`Scrape queue: ${st.enabled} targets, ${st.dueNow} due now, ${st.producing} have yielded before.`);
  }
      console.log(`Database ready. Google sign-in: ${authConfigured(config) ? 'enabled' : 'NOT configured'}`);
      startScheduler();
    } catch (e) {
      console.error('Database setup failed — scheduler not started:', e);
    }
  });
}

export default app;
