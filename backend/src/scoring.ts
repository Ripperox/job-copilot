import { Job, Profile, formatSalaryFloor } from './types';
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
Minimum salary: ${formatSalaryFloor(profile.salaryFloor)}
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

// The keyword fallback, used when there is no LLM key or the provider is spent.
//
// The previous version was `hits / terms.length * 100` over a substring match,
// which was wrong in both directions and filled the database with noise: two
// profile terms appearing ANYWHERE in a 4,000-character description scored the
// job 100, while a genuinely good role that happened not to contain the exact
// substring scored 0. Measured on the live pool, 1,595 of 1,833 jobs sat at
// 0-9 and so fell below the display floor, while the two highest-scoring jobs
// in the entire account were keyword artefacts reading "matched 2/2 of your key
// terms". `includes()` also matched "go" inside "django" and "category".
//
// Three rules fix it:
//   1. WORD BOUNDARIES, not substrings.
//   2. WEIGHT BY WHERE THE MATCH IS. A term in the title is evidence; the same
//      term buried in a benefits paragraph is nearly none.
//   3. NEVER CLAIM CERTAINTY IT HASN'T EARNED. Keyword overlap cannot tell an
//      excellent role from a mediocre one, so the whole scale is compressed
//      into a band sitting below anything the model calls a strong match. An
//      honest 55 is worth more than a fabricated 100.

/** Ceiling for any keyword-derived score. Below the LLM's "apply" band (80+) so
 *  a real judgement always outranks a guess, but above the UI's floor of 50 so
 *  the best guesses stay visible when no key is configured. */
const HEURISTIC_MAX = 68;

/** Floor for a plausible role, so a good job is never invisible merely because
 *  it words itself differently from the profile. */
const HEURISTIC_BASE = 22;

function hasWord(haystack: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return false;
  // Profile terms are user input and routinely contain "c++", "node.js", "ci/cd".
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b fails against a leading or trailing non-word character ("c++", ".net"),
  // so anchor on "not an identifier character, or the edge" instead.
  return new RegExp(`(?:^|[^a-z0-9+#.])${esc}(?:$|[^a-z0-9+#.])`, 'i').test(haystack);
}

export function heuristicScore(job: Job, profile: Profile): ScoreResult {
  const title = (job.title || '').toLowerCase();
  const body = (job.description || '').toLowerCase();
  const where = (job.location || '').toLowerCase();

  const roles = profile.roles.map((r) => r.toLowerCase()).filter(Boolean);
  const musts = profile.mustHaves.map((m) => m.toLowerCase()).filter(Boolean);

  let score = HEURISTIC_BASE;
  const why: string[] = [];

  // A wanted role in the TITLE is the strongest signal available without a model,
  // and it is weighted so that it ALONE clears the UI's floor of 50. A posting
  // actually called "Backend Engineer" must never be hidden from someone who
  // asked for backend engineer roles, whatever else does or doesn't match.
  const titleHits = roles.filter((r) => hasWord(title, r));
  if (titleHits.length) {
    score += 30;
    why.push(`title matches "${titleHits[0]}"`);
  } else if (roles.some((r) => hasWord(body, r))) {
    score += 8;
    why.push('role mentioned in the description');
  }

  // Must-haves are proportional — these are the terms the user said matter.
  if (musts.length) {
    const hit = musts.filter((m) => hasWord(title, m) || hasWord(body, m));
    if (hit.length) {
      score += Math.round((hit.length / musts.length) * 18);
      why.push(`${hit.length} of ${musts.length} must-haves (${hit.slice(0, 3).join(', ')})`);
    }
  }

  // Location, including remote — which a user's location list rarely spells out.
  const remote = /\bremote\b|\bwork from home\b|\banywhere\b/.test(`${title} ${where} ${body}`);
  if (profile.locations.some((l) => hasWord(where, l))) {
    score += 10;
    why.push('location matches');
  } else if (remote) {
    score += 8;
    why.push('remote');
  }

  // Seniority. The gate already removes clearly-too-senior roles, so this is the
  // softer signal: an explicitly junior title is a positive.
  if (/\b(junior|jr\.?|associate|entry[-\s]?level|graduate|grad|trainee|fresher)\b/i.test(title)) {
    score += 6;
    why.push('junior-level title');
  }

  score = Math.max(0, Math.min(HEURISTIC_MAX, score));

  let cvVariant = profile.cvVariants[0] ?? 'Default';
  const hay = `${title} ${body} ${where}`;
  if (/\b(ml|ai|llm|genai|nlp|machine learning)\b/.test(hay) && profile.cvVariants.includes('AI')) {
    cvVariant = 'AI';
  } else if (/\b(blockchain|web3|solidity|crypto|smart contract|solana|ethereum)\b/.test(hay) && profile.cvVariants.includes('Blockchain')) {
    cvVariant = 'Blockchain';
  }

  // Say plainly that no model read this, so a thin reason is not mistaken for a
  // considered judgement.
  const reason = why.length
    ? `Keyword match only — ${why.join(', ')}. Not read by a model.`
    : 'Keyword match only — no strong overlap with your profile. Not read by a model.';

  return { score, reason: reason.slice(0, 300), cvVariant };
}
