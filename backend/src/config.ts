import * as dotenv from 'dotenv';
dotenv.config();

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
  // Google Gemini — generous free tier (1M TPM, ~1500 req/day). Preferred when set.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
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
  greenhouseBoards: (process.env.GREENHOUSE_BOARDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  leverBoards: (process.env.LEVER_BOARDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // ---- Web scraping (company career pages) ----
  // Tried in this order; the chain falls through when one is out of quota.
  // Jina works with no key at all, so there is always a last resort.
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  exaApiKey: process.env.EXA_API_KEY || '',
  jinaApiKey: process.env.JINA_API_KEY || '',
  // Comma-separated career-page URLs to scrape for openings.
  scrapeCareerPages: (process.env.SCRAPE_CAREER_PAGES || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Career pages are scraped FAR less often than the aggregators are fetched.
  // Firecrawl's free tier is 1000 credits/month and one page costs one credit,
  // so 24 pages on the hourly job schedule would be ~17,000 credits/month and
  // die in two days. Once a day is ~720/month, which fits with headroom.
  scrapeIntervalHours: Number(process.env.SCRAPE_INTERVAL_HOURS ?? 24),
  // Hard ceiling per run, so a long target list cannot spike usage.
  scrapeMaxPagesPerRun: Number(process.env.SCRAPE_MAX_PAGES_PER_RUN ?? 30),

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
