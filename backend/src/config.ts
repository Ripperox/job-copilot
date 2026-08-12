import { CAREER_PAGE_TARGETS } from './sources/targets';
import * as dotenv from 'dotenv';
dotenv.config();

// Comma-separated env list with a shipped default.
function list(v: string | undefined, fallback: string): string[] {
  // Note the emptiness check rather than ??: an env var present but blank
  // (GREENHOUSE_BOARDS= in .env) is not nullish, so ?? kept the empty string
  // and silently disabled the source.
  const raw = v && v.trim() ? v : fallback;
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 4500,
  // How often the backend auto-fetches from all sources, in minutes. 0 disables
  // the scheduler (manual POST /api/fetch only). Default: hourly.
  fetchIntervalMinutes: Number(process.env.FETCH_INTERVAL_MINUTES ?? 60),
  adzunaAppId: process.env.ADZUNA_APP_ID || '',
  adzunaAppKey: process.env.ADZUNA_APP_KEY || '',
  adzunaCountry: process.env.ADZUNA_COUNTRY || 'in',
  // Groq (free, fast, OpenAI-compatible) — preferred when set.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  // Google Gemini — measured 2026-08-04: only ~20 requests/day free on
  // gemini-3.6-flash, and 0 on the older 2.0 models.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  // Cerebras — by far the largest free tier (~1M tokens/day, 14,400 req/day),
  // which is why it is preferred. Free-tier context is capped near 8k tokens,
  // so batches sent to it are deliberately smaller.
  cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
  cerebrasModel: process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
  // JSearch via RapidAPI (aggregates Google for Jobs → LinkedIn, Indeed, Glassdoor…)
  jsearchApiKey: process.env.JSEARCH_RAPIDAPI_KEY || '',
  // Pages per role query (10 jobs/page). More = more coverage but more API quota.
  jsearchPages: Number(process.env.JSEARCH_PAGES) || 1,
  // Fantastic.jobs APIs (RapidAPI, same key): Active Jobs DB (200k+ career sites/ATS)
  // and LinkedIn Job Search. Default to the shared RapidAPI key.
  activeJobsApiKey: process.env.ACTIVE_JOBS_RAPIDAPI_KEY || process.env.JSEARCH_RAPIDAPI_KEY || '',
  linkedinJobsApiKey: process.env.LINKEDIN_JOBS_RAPIDAPI_KEY || process.env.JSEARCH_RAPIDAPI_KEY || '',
  // Jooble aggregator (strong India coverage)
  joobleApiKey: process.env.JOOBLE_API_KEY || '',
  // comma-separated Greenhouse board tokens, e.g. "stripe,airbnb"
  // Public ATS boards — free, unmetered, no key. These carry the load now that
  // JSearch, Active Jobs and LinkedIn are all monthly-quota exhausted.
  //
  // Defaults are shipped in code rather than left to env vars because the env
  // route has repeatedly failed us: a blueprint sync will not retrofit vars
  // onto an existing service, and hand-pasting ate a hyphen twice. Every token
  // below was verified live on 2026-08-05. Set the env var to override.
  //
  // Curated for one candidate profile: companies that hire in India or hire
  // genuinely globally-remote. Postings are location-filtered again in
  // ats-filter.ts, because these boards are large and mostly US-only.
  //
  // Every token added on 2026-08-12 was verified by calling the board API and
  // counting jobs; the count is in the comment beside it. A token that answers
  // 200 with an EMPTY board is worse than no token — it reads as healthy in the
  // status panel while contributing nothing. Optiver is the live example:
  // boards-api returns 200 for `optiver` and zero jobs in every department, so
  // it is a scrape target in targets.ts instead of a board here.
  greenhouseBoards: list(
    process.env.GREENHOUSE_BOARDS,
    'phonepe,groww,druva,postman,turing,mongodb,databricks,rubrik,adyen,bitgo,gitlab,mercury,vercel,'+
    'tailscale,planetscale,clickhouse,temporaltechnologies,'+
    // --- added 2026-08-12: quant, HFT and fintech ---
    'towerresearchcapital,'+          // 79
    'gravitonresearchcapital,'+       // 21
    'alphagrepsecurities,'+           // 16
    'quantboxresearchpte,'+           // 6 — EU-hosted board, global API serves it
    'worldquant,'+                    // 101
    'imc,'+                           // 165
    'arcesiumllc,'+                   // 35
    'razorpaysoftwareprivatelimited,'+// 21
    'inmobi',                         // 68
  ),
  leverBoards: list(process.env.LEVER_BOARDS, 'meesho,porter,zeta,mindtickle,cred'),
  ashbyBoards: list(
    process.env.ASHBY_BOARDS,
    'supabase,linear,railway,neon,sentilink,atlan,navi,incident,zapier,ramp,plaid,alchemy,anyscale',
  ),

  // ---- Web scraping (company career pages) ----
  // Tried in this order; the chain falls through when one is out of quota.
  // Jina works with no key at all, so there is always a last resort.
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  exaApiKey: process.env.EXA_API_KEY || '',
  jinaApiKey: process.env.JINA_API_KEY || '',
  // Comma-separated career-page URLs to scrape for openings.
  // Measured 2026-08-06: of the original 24 targets, only 8 returned any job
  // signal at all — the rest are JS-rendered boards that hand a scraper nothing
  // but navigation. PhonePe and Meesho were dropped too, not for lack of
  // content but because their Greenhouse/Lever boards cover them structurally
  // and for free, while scraping costs LLM tokens per page.
  //
  // Six pages at 4 per run means full coverage every ~4.5 hours instead of 18,
  // and no credits burned on pages that cannot yield.
  // Targets live in sources/targets.ts, not here — the queue in Postgres tracks
  // when each was last read, so the list only says WHICH urls exist.
  // SCRAPE_CAREER_PAGES still overrides for a one-off.
  scrapeCareerPages: list(process.env.SCRAPE_CAREER_PAGES, CAREER_PAGE_TARGETS.join(',')),
  // Career pages are scraped FAR less often than the aggregators are fetched.
  // Firecrawl's free tier is 1000 credits/month and one page costs one credit,
  // so 24 pages on the hourly job schedule would be ~17,000 credits/month and
  // die in two days. Once a day is ~720/month, which fits with headroom.
  // 3h, not 24h: paired with a small page window below, the whole list is
  // covered roughly every 18 hours in short runs that actually finish.
  scrapeIntervalHours: Number(process.env.SCRAPE_INTERVAL_HOURS ?? 3),
  // Hard ceiling per run, so a long target list cannot spike usage.
  // 4, not 30. With 24 targets the old default read the ENTIRE list every run
  // — 465s measured — so the rotation this was meant to enable never happened,
  // and a run that long does not survive a free-tier host. 4 pages is ~60-90s.
  // Budget check: 4 pages x 8 runs/day = 32 Firecrawl credits/day, ~960/month,
  // just inside the 1,000/month free allowance.
  // Cap on how many jobs one run will score.
  //
  // Scoring and career-page extraction draw on the SAME daily LLM budget, and
  // scoring wins by volume: importing the ATS boards queued 790 jobs, burned
  // both free tiers in one tick, and the scrape three minutes later got
  // "every LLM provider is spent" with four pages already fetched.
  //
  // That priority is backwards. Extraction needs ~4 requests and yields roles
  // available nowhere else; scoring needs hundreds and degrades gracefully to
  // keyword matching. Capping the run leaves headroom for extraction and
  // spreads a large import over several ticks instead of starving everything.
  maxScorePerRun: Number(process.env.MAX_SCORE_PER_RUN ?? 150),
  scrapeMaxPagesPerRun: Number(process.env.SCRAPE_MAX_PAGES_PER_RUN ?? 4),

  // ---- Auth ----
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  oauthRedirectUrl: process.env.OAUTH_REDIRECT_URL || 'http://localhost:4500/api/auth/google/callback',
  // Signs the session cookie. Sessions are invalidated if this changes.
  sessionSecret: process.env.SESSION_SECRET || '',
  // Encrypts users' stored LLM keys at rest (Phase 4).
  keyEncryptionSecret: process.env.KEY_ENCRYPTION_SECRET || '',
  // Comma-separated allowed browser origins. Cookies require an explicit origin
  // (never a wildcard), so every dev port that serves the frontend is listed.
  frontendOrigins: (process.env.FRONTEND_ORIGIN ||
    'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176')
    .split(',').map((s) => s.trim()).filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',
};

// True when Google sign-in is fully configured. When false the server still runs,
// but the auth routes report 503 instead of redirecting to a broken consent screen.
export function authConfigured(c: Config = config): boolean {
  return Boolean(c.googleClientId && c.googleClientSecret && c.sessionSecret);
}

export type Config = typeof config;
