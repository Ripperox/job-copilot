import { Job, Profile } from './types';
import { config as defaultConfig, Config } from './config';
import { llmComplete, hasLLM, llmProvider } from './llm';
import { ScoreResult, scoreJob, gateJob, heuristicScore } from './scoring';

// Batched scoring: many jobs per LLM request instead of one.
//
// Why it matters: providers cap you on requests-per-day AND tokens-per-minute,
// and you hit whichever binds first. Scoring one job per request burns the
// request budget at the worst possible rate — Gemini's free tier is 20 requests
// a day, so one-job-per-request means 20 jobs a day. At 50 jobs per request the
// same 20 requests cover 1,000 jobs/day.
//
// The résumé is also sent once per BATCH rather than once per job, which roughly
// halves token usage and therefore helps token-limited providers (Groq) too.
//
// The hard rule of this module: EVERY input job comes back with a result. A
// batch that errors, truncates, or silently drops entries always degrades —
// split, then per-job, then heuristic — never to a missing score.

// Per-job description budget inside a batch. Much shorter than the 4000 chars a
// single-job prompt uses: enough to judge fit, small enough that 50 jobs fit in
// one request.
const BATCH_DESC_CHARS = 1200;

// Batch sizes are provider-shaped, because the binding limit differs:
//   gemini    — request-limited (20/day free), so batch big: 50 × ~330 tok ≈ 17k
//   groq      — token-limited (12k tokens/min), so batch small enough to fit
//   anthropic — comfortable either way
const BATCH_SIZE: Record<string, number> = {
  gemini: 50,
  groq: 20,
  anthropic: 30,
  heuristic: 0,
};

// Gap between batches so a token-per-minute limit is not tripped by back-to-back
// requests. Groq's 12k TPM is the tight one.
const PACING_MS: Record<string, number> = {
  gemini: 0,
  groq: 4000,
  anthropic: 1000,
  heuristic: 0,
};

export interface BatchScoreOutcome {
  results: Map<string, ScoreResult>;
  /** Jobs answered by the cheap gates, with no LLM call at all. */
  gated: number;
  /** Jobs whose score came from a batched LLM response. */
  batched: number;
  /** Jobs that needed an individual retry because the batch omitted them. */
  individual: number;
  /** Jobs that ended on the keyword heuristic. */
  heuristic: number;
  llmRequests: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Score many jobs, using as few LLM requests as possible.
 * Guarantees a result for every input job.
 */
export async function scoreJobsBatched(
  jobs: Job[],
  profile: Profile,
  config: Config = defaultConfig,
): Promise<BatchScoreOutcome> {
  const out: BatchScoreOutcome = {
    results: new Map(),
    gated: 0,
    batched: 0,
    individual: 0,
    heuristic: 0,
    llmRequests: 0,
  };
  if (!jobs.length) return out;

  // 1. Cheap gates first — they cost nothing and typically remove most of the
  //    pool (senior titles, non-engineering roles), so the LLM only sees the
  //    jobs where its judgement is actually worth spending a request on.
  const needsLLM: Job[] = [];
  for (const job of jobs) {
    const gated = gateJob(job, profile);
    if (gated) {
      out.results.set(job.id, gated);
      out.gated++;
    } else {
      needsLLM.push(job);
    }
  }

  if (!needsLLM.length) return out;

  // 2. No LLM configured → heuristic for the rest.
  if (!hasLLM(config)) {
    for (const job of needsLLM) {
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
    }
    return out;
  }

  const provider = llmProvider(config);
  const size = Math.max(1, BATCH_SIZE[provider] ?? 20);
  const pace = PACING_MS[provider] ?? 1000;

  for (let i = 0; i < needsLLM.length; i += size) {
    const batch = needsLLM.slice(i, i + size);
    if (i > 0 && pace) await sleep(pace);
    await scoreBatchWithFallbacks(batch, profile, config, out, 0);
  }

  return out;
}

// Scores one batch, degrading rather than failing:
//   request error  → split in half and retry (depth-limited), then per-job
//   bad/partial JSON → keep whatever parsed, per-job the remainder
//   missing ids    → per-job those specific jobs
async function scoreBatchWithFallbacks(
  batch: Job[],
  profile: Profile,
  config: Config,
  out: BatchScoreOutcome,
  depth: number,
): Promise<void> {
  if (!batch.length) return;

  // A single job has nothing left to split; score it directly.
  if (batch.length === 1) {
    await scoreIndividually(batch, profile, config, out);
    return;
  }

  let text: string;
  try {
    out.llmRequests++;
    text = await llmComplete(batchPrompt(batch, profile), config, batchMaxTokens(batch.length));
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // Splitting helps when the failure is size-related (token limits, output
    // truncation). Two levels is enough to reach a small batch; beyond that,
    // stop halving and just do them one by one.
    if (depth < 2) {
      console.error(`batch of ${batch.length} failed (${message.slice(0, 120)}) — splitting`);
      const mid = Math.ceil(batch.length / 2);
      await scoreBatchWithFallbacks(batch.slice(0, mid), profile, config, out, depth + 1);
      await scoreBatchWithFallbacks(batch.slice(mid), profile, config, out, depth + 1);
    } else {
      console.error(`batch of ${batch.length} failed (${message.slice(0, 120)}) — scoring individually`);
      await scoreIndividually(batch, profile, config, out);
    }
    return;
  }

  const parsed = parseBatchResponse(text, profile);
  const missing: Job[] = [];

  for (const job of batch) {
    const r = parsed.get(job.id);
    if (r) {
      out.results.set(job.id, r);
      out.batched++;
    } else {
      missing.push(job);
    }
  }

  if (missing.length) {
    console.error(`batch response omitted ${missing.length}/${batch.length} jobs — retrying those individually`);
    await scoreIndividually(missing, profile, config, out);
  }
}

// Last-resort path: scoreJob already falls back to the heuristic internally, so
// this cannot throw or leave a job unscored.
async function scoreIndividually(
  jobs: Job[],
  profile: Profile,
  config: Config,
  out: BatchScoreOutcome,
): Promise<void> {
  for (const job of jobs) {
    try {
      const r = await scoreJob(job, profile, config);
      out.results.set(job.id, r);
      if (r.reason.startsWith('Heuristic:')) out.heuristic++;
      else out.individual++;
    } catch (e) {
      // scoreJob is already defensive, but never let one job break the run.
      console.error('individual scoring failed for', job.id, e);
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
    }
  }
}

// Output budget: each job needs roughly 60 tokens of JSON. Add generous headroom
// because thinking models spend output tokens on thoughts, and a truncated array
// costs us the whole batch.
function batchMaxTokens(jobCount: number): number {
  return Math.min(32000, 2048 + jobCount * 120);
}

function batchPrompt(jobs: Job[], profile: Profile): string {
  const variants = profile.cvVariants.length ? profile.cvVariants : ['Default'];
  const jobBlocks = jobs
    .map(
      (j, i) => `--- JOB ${i + 1} ---
id: ${j.id}
Title: ${j.title}
Company: ${j.company}
Location: ${j.location}
Salary: ${j.salary ?? 'n/a'}
Description: ${j.description.slice(0, BATCH_DESC_CHARS).replace(/\s+/g, ' ')}`,
    )
    .join('\n\n');

  return `You help a job seeker decide which roles to APPLY to. You will score ${jobs.length} jobs against ONE candidate.

The candidate is EQUALLY happy in BACKEND or FULL-STACK roles — treat both as primary targets, and NEVER down-score a full-stack role just because their resume leans backend.

Scoring guide (apply to EACH job independently):
- 80+ = APPLY. A backend OR full-stack role at their level using a related stack. React / Node / TypeScript / JavaScript / MERN full-stack at their level is 80+. Backend in Node / Python / general is 80+.
- 50-79 = partial: right level but a clearly DIFFERENT primary stack (.NET / C#, PHP, Vue-only, Ruby, or pure-mobile / React Native) or weaker overlap.
- below 50 = wrong level, wrong field, or an unrelated stack/domain.
A capable engineer is hired across adjacent stacks all the time — don't demand an exact tech match.

MOST IMPORTANT RULE — experience level: the candidate has at most ${profile.maxYoE ?? 3} years of experience. If a role is senior/lead/principal/staff/managerial, or requires more than ${profile.maxYoE ?? 3} years, score it BELOW 25 no matter how well the skills match, and say so in the reason.

CANDIDATE
Roles wanted: ${profile.roles.join(', ') || 'n/a'}
Max years of experience: ${profile.maxYoE ?? 3}
Preferred locations: ${profile.locations.join(', ') || 'n/a'}
Must-haves: ${profile.mustHaves.join(', ') || 'n/a'}
Minimum salary (LPA): ${profile.salaryFloorLPA ?? 'n/a'}
CV variants available: ${variants.join(', ')}
Resume:
${profile.resumeText.slice(0, 6000)}

JOBS TO SCORE
${jobBlocks}

Return ONLY a JSON array with EXACTLY ${jobs.length} objects — one per job, using the job's "id" verbatim. No markdown, no commentary:
[{"id":"<job id>","score":<0-100 integer>,"reason":"<one concise sentence>","cvVariant":"<best fit from: ${variants.join(', ')}>"}]`;
}

/**
 * Parse a batch response into id → result.
 *
 * Deliberately forgiving: models wrap arrays in prose or markdown fences, and a
 * truncated response leaves the array unclosed. Rather than all-or-nothing
 * JSON.parse, we salvage every well-formed object we can find — a truncated
 * batch of 50 still yields the 48 that arrived intact.
 */
export function parseBatchResponse(text: string, profile: Profile): Map<string, ScoreResult> {
  const results = new Map<string, ScoreResult>();
  const variants = profile.cvVariants.length ? profile.cvVariants : ['Default'];

  const add = (raw: any) => {
    if (!raw || typeof raw !== 'object') return;
    const id = typeof raw.id === 'string' ? raw.id : null;
    if (!id) return;
    const score = Number(raw.score);
    if (!Number.isFinite(score)) return;
    results.set(id, {
      score: Math.max(0, Math.min(100, Math.round(score))),
      reason: String(raw.reason ?? '').slice(0, 300),
      cvVariant: variants.includes(raw.cvVariant) ? raw.cvVariant : variants[0],
    });
  };

  // Fast path: a clean array somewhere in the response.
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        parsed.forEach(add);
        if (results.size) return results;
      }
    } catch {
      // fall through to object-by-object salvage
    }
  }

  // Salvage path: pull out individual {...} objects. Handles truncation, stray
  // prose, and markdown fences.
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      add(JSON.parse(m[0]));
    } catch {
      // skip this fragment
    }
  }

  return results;
}
