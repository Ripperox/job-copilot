import { Job, Profile } from './types';
import { config as defaultConfig, Config } from './config';
import { checkSeniority } from './experience';
import { llmComplete, hasLLM } from './llm';

export interface ScoreResult {
  score: number; // 0-100
  reason: string;
  cvVariant: string;
}

// Titles worth an LLM call. Non-engineering roles (sales, marketing, support…)
// that flood big company boards are skipped cheaply. Gating on the TITLE (not the
// description) avoids discarding real dev jobs that have sparse snippets.
const ENG_TITLE =
  /\b(engineer|engineering|developer|programmer|software|sde|backend|back[-\s]?end|frontend|front[-\s]?end|full[-\s]?stack|web|data|ml|ai|devops|sre|qa|tester|architect|coder|dev)\b/i;

// Score a job against the candidate profile. Uses the Anthropic API when a key
// is configured; otherwise falls back to a keyword heuristic so the app still
// works with zero setup.
/**
 * The two cheap gates that run before any LLM call. Returns a finished result
 * when the job can be judged for free, or null when it genuinely needs the LLM.
 *
 * Shared by single-job and batched scoring so both apply identical rules — and
 * so batching only ever spends requests on jobs the gates could not settle.
 */
export function gateJob(job: Job, profile: Profile): ScoreResult | null {
  const defaultVariant = profile.cvVariants[0] ?? 'Default';

  // 1. Experience gate FIRST — a junior can't get a senior role, so short-circuit
  //    with a low score and DON'T spend an LLM call on it.
  const seniority = checkSeniority(job, profile.maxYoE);
  if (seniority.tooSenior) {
    return { score: 5, reason: `Above your experience level (${seniority.note}).`, cvVariant: defaultVariant };
  }

  // 2. Title gate — only engineering/dev roles are worth an LLM call. Skips the
  //    sales/marketing/support roles that flood big boards, without discarding
  //    real dev jobs that have sparse descriptions.
  if (!ENG_TITLE.test(job.title)) return heuristicScore(job, profile);

  return null;
}

export async function scoreJob(job: Job, profile: Profile, config: Config = defaultConfig): Promise<ScoreResult> {
  const gated = gateJob(job, profile);
  if (gated) return gated;

  // 3. LLM-score only the promising, junior-eligible jobs.
  if (hasLLM(config)) {
    try {
      return await scoreWithLLM(job, profile, config);
    } catch (e) {
      console.error('LLM scoring failed, using heuristic:', e);
      return heuristicScore(job, profile);
    }
  }
  return heuristicScore(job, profile);
}

// Exported for the batch scorer, which needs the raw error (rate limits in
// particular) rather than scoreJob's silent heuristic fallback.
export async function scoreWithLLM(job: Job, profile: Profile, config: Config): Promise<ScoreResult> {
  const prompt = `You help a job seeker decide whether to APPLY. The candidate is EQUALLY happy in BACKEND or FULL-STACK roles — treat both as primary targets, and NEVER down-score a full-stack role just because their resume leans backend.

Score for apply-worthiness, not a perfect match:
- 80+ = APPLY. A backend OR full-stack role at their level using a related stack. A React / Node / TypeScript / JavaScript / MERN / MEAN full-stack role at their level is 80+. A backend role in Node / Python / general is 80+.
- 50-79 = partial: right level but a clearly DIFFERENT primary stack (.NET / C#, PHP, Vue-only, Ruby, or pure-mobile / React Native) or weaker overlap.
- below 50 = wrong level, wrong field, or an unrelated stack/domain.
A capable engineer is hired across adjacent stacks all the time — don't demand an exact tech match.

MOST IMPORTANT RULE — experience level: the candidate has at most ${profile.maxYoE ?? 3} years of experience. If the role is senior/lead/principal/staff/managerial, or requires more than ${profile.maxYoE ?? 3} years, score it BELOW 25 no matter how well the skills match, and say so in the reason. Only give 80+ to roles a candidate with ${profile.maxYoE ?? 3} years could realistically be hired for (junior / associate / mid-level).

CANDIDATE
Roles wanted: ${profile.roles.join(', ') || 'n/a'}
Max years of experience: ${profile.maxYoE ?? 3}
Preferred locations: ${profile.locations.join(', ') || 'n/a'}
Must-haves: ${profile.mustHaves.join(', ') || 'n/a'}
Minimum salary (LPA): ${profile.salaryFloorLPA ?? 'n/a'}
CV variants available: ${profile.cvVariants.join(', ') || 'Default'}
Resume:
${profile.resumeText.slice(0, 6000)}

JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Salary: ${job.salary ?? 'n/a'}
Description:
${job.description.slice(0, 4000)}

Return ONLY JSON: {"score": <0-100 integer>, "reason": "<one concise sentence>", "cvVariant": "<the single best-fitting CV variant from the list>"}`;

  const text = await llmComplete(prompt, config, 300);
  const match = text.match(/\{[\s\S]*\}/);
  const json = JSON.parse(match ? match[0] : text);
  const variants = profile.cvVariants.length ? profile.cvVariants : ['Default'];
  const picked = variants.includes(json.cvVariant) ? json.cvVariant : variants[0];
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(json.score) || 0))),
    reason: String(json.reason ?? '').slice(0, 300),
    cvVariant: picked,
  };
}

export function heuristicScore(job: Job, profile: Profile): ScoreResult {
  const hay = `${job.title} ${job.description} ${job.location}`.toLowerCase();
  const terms = [...profile.roles, ...profile.mustHaves].map((t) => t.toLowerCase()).filter(Boolean);
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  const score = terms.length ? Math.round((hits / terms.length) * 100) : 0;

  let cvVariant = profile.cvVariants[0] ?? 'Default';
  if (/\b(ml|ai|llm|genai|nlp|machine learning)\b/.test(hay) && profile.cvVariants.includes('AI')) {
    cvVariant = 'AI';
  } else if (/\b(blockchain|web3|solidity|crypto|smart contract|solana|ethereum)\b/.test(hay) && profile.cvVariants.includes('Blockchain')) {
    cvVariant = 'Blockchain';
  }
  return {
    score,
    reason: `Heuristic: matched ${hits}/${terms.length} of your key terms.`,
    cvVariant,
  };
}
