import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 4500,
  adzunaAppId: process.env.ADZUNA_APP_ID || '',
  adzunaAppKey: process.env.ADZUNA_APP_KEY || '',
  adzunaCountry: process.env.ADZUNA_COUNTRY || 'in',
  // Groq (free, fast, OpenAI-compatible) — preferred when set.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
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
};

export type Config = typeof config;
