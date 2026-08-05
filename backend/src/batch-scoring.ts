import { Job, Profile } from './types';
import { config as defaultConfig, Config } from './config';
import {
  llmComplete,
  hasLLM,
  isTerminalForRun,
  terminalReason,
  llmProviderChain,
  configForProvider,
  LLMProvider,
} from './llm';
import { ScoreResult, gateJob, heuristicScore, scoreWithLLM } from './scoring';

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
//   gemini    — request-limited (20/day free), so bigger is strictly better...
//               but its reasoning tokens truncate very large batches (measured
//               2026-08-04: 50 jobs came back with only 6 complete objects).
//               25 still covers ~500 jobs/day within 20 requests.
//   groq      — token-limited (12k tokens/min), so batch small enough to fit
//   anthropic — comfortable either way
const BATCH_SIZE: Record<string, number> = {
  // Cerebras has the most daily capacity but caps context near 8k tokens on the
  // free tier, so keep each request small and just make more of them — 14,400
  // requests/day means request count is not the scarce resource there.
  cerebras: 8,
  gemini: 25,
  groq: 20,
  anthropic: 30,
  heuristic: 0,
};

// Gap between batches so a token-per-minute limit is not tripped by back-to-back
// requests. Groq's 12k TPM is the tight one.
const PACING_MS: Record<string, number> = {
  // 30 requests/minute on the free tier.
  cerebras: 2200,
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
  /** True when the provider rejected us (bad key or quota) and the run stopped calling it. */
  rateLimited: boolean;
}

// Once a provider rejects us for a reason that will not change during this run
// (bad key, exhausted quota, unpaid model), every further call to THAT provider
// is wasted. But it says nothing about the others.
//
// Free tiers die constantly and without warning — Groq is 100k tokens/day,
// Gemini is 20 requests/day, Cerebras started returning 402 mid-project. So the
// run walks a chain: retire the dead provider, carry on with the next one, and
// only fall back to the keyword heuristic once every provider is spent.
class ProviderChain {
  private i = 0;
  private budget: number;
  readonly retired: string[] = [];

  constructor(
    private readonly order: LLMProvider[],
    private readonly base: Config,
    jobCount = 0,
  ) {
    // Hard ceiling on requests for the whole run, independent of any provider's
    // behaviour. Splitting and per-job retries are bounded in principle, but a
    // misclassified error has already turned 30 jobs into 106 requests once and
    // 40 into 55 a second time. This makes that class of bug impossible rather
    // than merely unlikely: roughly three attempts per nominal batch, plus a
    // couple per provider for the handover, and never fewer than 12.
    this.budget = Math.max(12, Math.ceil(jobCount / 8) * 3 + order.length * 2);
  }

  get active(): LLMProvider | null {
    return this.order[this.i] ?? null;
  }

  /** True once every provider is retired OR the run's request budget is gone. */
  get spent(): boolean {
    return this.i >= this.order.length || this.budget <= 0;
  }

  /** Claim one request. Returns false when the run has spent its budget. */
  spend(): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    if (this.budget === 0) {
      console.error('run hit its LLM request ceiling — heuristic for the remainder');
    }
    return true;
  }

  /** Config narrowed to the active provider, so no call can silently use another. */
  config(): Config {
    return configForProvider(this.base, this.active!);
  }

  /** Give up on the active provider. Returns true if another one is left. */
  retire(e: unknown): boolean {
    const dead = this.order[this.i];
    this.retired.push(dead);
    this.i++;
    const next = this.active;
    console.error(
      `${dead} ${terminalReason(e)} — ${next ? `switching to ${next}` : 'no providers left, heuristic for the rest of this run'}`,
    );
    return !this.spent;
  }
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
    rateLimited: false,
  };
  if (!jobs.length) return out;
  const chain = new ProviderChain(llmProviderChain(config), config, jobs.length);

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

  // Batch size and pacing are provider-shaped, and the provider can change
  // mid-run when one is retired, so they are recomputed per batch rather than
  // hoisted out of the loop.
  let i = 0;
  let batchNo = 0;
  while (i < needsLLM.length) {
    if (chain.spent) {
      for (const job of needsLLM.slice(i)) {
        out.results.set(job.id, heuristicScore(job, profile));
        out.heuristic++;
      }
      break;
    }
    const provider = chain.active!;
    const size = Math.max(1, BATCH_SIZE[provider] ?? 20);
    const pace = PACING_MS[provider] ?? 1000;
    const batch = needsLLM.slice(i, i + size);
    i += batch.length;
    if (batchNo++ > 0 && pace) await sleep(pace);
    await scoreBatchWithFallbacks(batch, profile, chain, out, 0);
  }

  // "Rate limited" now means the run ran out of providers entirely, not that
  // the first one blinked.
  out.rateLimited = chain.spent;
  return out;
}

// Scores one batch, degrading rather than failing:
//   request error  → split in half and retry (depth-limited), then per-job
//   bad/partial JSON → keep whatever parsed, per-job the remainder
//   missing ids    → per-job those specific jobs
async function scoreBatchWithFallbacks(
  batch: Job[],
  profile: Profile,
  chain: ProviderChain,
  out: BatchScoreOutcome,
  depth: number,
): Promise<void> {
  if (!batch.length) return;

  if (chain.spent) {
    for (const job of batch) {
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
    }
    return;
  }

  // A single job has nothing left to split; score it directly.
  if (batch.length === 1) {
    await scoreIndividually(batch, profile, chain, out);
    return;
  }

  if (!chain.spend()) {
    for (const job of batch) {
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
    }
    return;
  }

  let text: string;
  try {
    out.llmRequests++;
    text = await llmComplete(batchPrompt(batch, profile), chain.config(), batchMaxTokens(batch.length));
  } catch (e: unknown) {
    const message = String((e as Error)?.message ?? e);

    // A rate limit is NOT a size problem. Splitting and retrying would multiply
    // requests against a limit we have already hit — the opposite of helping.
    // Retire this provider and hand the SAME batch to the next one; the chain
    // only advances, so this can recurse at most once per configured provider.
    if (isTerminalForRun(e)) {
      if (chain.retire(e)) {
        await scoreBatchWithFallbacks(batch, profile, chain, out, 0);
      } else {
        for (const job of batch) {
          out.results.set(job.id, heuristicScore(job, profile));
          out.heuristic++;
        }
      }
      return;
    }

    // Other failures may well be size-related (token ceiling, truncated output),
    // where halving genuinely helps. Two levels, then one-by-one.
    if (depth < 2) {
      console.error(`batch of ${batch.length} failed (${message.slice(0, 120)}) — splitting`);
      const mid = Math.ceil(batch.length / 2);
      await scoreBatchWithFallbacks(batch.slice(0, mid), profile, chain, out, depth + 1);
      await scoreBatchWithFallbacks(batch.slice(mid), profile, chain, out, depth + 1);
    } else {
      console.error(`batch of ${batch.length} failed (${message.slice(0, 120)}) — scoring individually`);
      await scoreIndividually(batch, profile, chain, out);
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
    await scoreIndividually(missing, profile, chain, out);
  }
}

// Last-resort path: scoreJob already falls back to the heuristic internally, so
// this cannot throw or leave a job unscored.
async function scoreIndividually(
  jobs: Job[],
  profile: Profile,
  chain: ProviderChain,
  out: BatchScoreOutcome,
): Promise<void> {
  for (const job of jobs) {
    if (chain.spent || !chain.spend()) {
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
      continue;
    }
    try {
      out.llmRequests++;
      const r = await scoreWithLLMOrThrow(job, profile, chain.config());
      out.results.set(job.id, r);
      out.individual++;
    } catch (e) {
      // Surface the rate limit rather than swallowing it inside scoreJob, so the
      // chain can move on instead of every remaining job making its own doomed
      // call to a provider that has already said no.
      if (isTerminalForRun(e)) {
        if (chain.retire(e) && chain.spend()) {
          // Same job, next provider. The chain only advances, so this terminates.
          out.llmRequests++;
          try {
            const r = await scoreWithLLMOrThrow(job, profile, chain.config());
            out.results.set(job.id, r);
            out.individual++;
            continue;
          } catch {
            // fall through to the heuristic below
          }
        }
      }
      out.results.set(job.id, heuristicScore(job, profile));
      out.heuristic++;
    }
  }
}

// scoreJob swallows LLM errors internally (it always returns a result), which
// hides rate limits from the breaker. For the batch path we need the error, so
// the gates run first and then the LLM call is made directly.
async function scoreWithLLMOrThrow(job: Job, profile: Profile, config: Config): Promise<ScoreResult> {
  const gated = gateJob(job, profile);
  if (gated) return gated;
  return scoreWithLLM(job, profile, config);
}

// Output budget: each job needs roughly 60 tokens of JSON. Add generous headroom
// because thinking models spend output tokens on thoughts, and a truncated array
// costs us the whole batch.
// Reasoning models (gemini-*-latest) spend from this SAME budget on thinking
// before emitting a character of the answer, so a tight ceiling silently
// truncates the array. Being generous costs nothing — providers meter tokens
// actually produced, not the ceiling requested.
function batchMaxTokens(jobCount: number): number {
  return Math.min(65536, 8192 + jobCount * 400);
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
