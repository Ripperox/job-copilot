import { Job, Profile, OutreachTarget } from './types';
import { config as defaultConfig, Config } from './config';
import { llmComplete, hasLLM } from './llm';

export interface OutreachContent {
  referralMessage: string;
  applicationNote: string;
  targets: OutreachTarget[];
}

// Build LinkedIn people-search links for the roles worth contacting at a company.
// These are just pre-filled searches the user clicks — nothing is scraped or automated.
function buildTargets(company: string): OutreachTarget[] {
  const titles = [
    'Engineering Manager',
    'Engineering Team Lead',
    'Technical Recruiter',
    'Talent Acquisition / HR',
  ];
  return titles.map((title) => ({
    title,
    searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${title} ${company}`)}`,
  }));
}

export async function generateOutreach(job: Job, profile: Profile, config: Config = defaultConfig): Promise<OutreachContent> {
  const targets = buildTargets(job.company);
  if (hasLLM(config)) {
    try {
      const { referralMessage, applicationNote } = await withLLM(job, profile, config);
      return { referralMessage, applicationNote, targets };
    } catch (e) {
      console.error('LLM outreach failed, using template:', e);
    }
  }
  return { ...template(job, profile), targets };
}

async function withLLM(job: Job, profile: Profile, config: Config): Promise<{ referralMessage: string; applicationNote: string }> {
  const prompt = `You are helping a candidate reach out about a job. Write in the candidate's own voice — natural, specific, and concise. No corporate fluff, no "I hope this finds you well", no overclaiming.

CANDIDATE RESUME (for real specifics to reference):
${profile.resumeText.slice(0, 5000)}

JOB
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description:
${job.description.slice(0, 3000)}

Write TWO things:
1. "referralMessage": a short LinkedIn DM (60-90 words) to someone at ${job.company} (an engineer, EM, or recruiter) asking for a referral or quick feedback on their ${job.title} opening. Reference ONE concrete, relevant thing from the candidate's background that maps to this role. Warm, direct, easy to say yes to.
2. "applicationNote": a 2-3 sentence "why this company / why this role" note the candidate could paste into an application, grounded in one specific strength that fits this job.

Return ONLY JSON: {"referralMessage": "...", "applicationNote": "..."}`;

  const text = await llmComplete(prompt, config, 600);
  const match = text.match(/\{[\s\S]*\}/);
  const json = JSON.parse(match ? match[0] : text);
  return {
    referralMessage: String(json.referralMessage ?? '').trim(),
    applicationNote: String(json.applicationNote ?? '').trim(),
  };
}

// Decent filled-in template used when no LLM key is set. The user edits before sending.
function template(job: Job, profile: Profile): { referralMessage: string; applicationNote: string } {
  const role = profile.roles[0] || 'engineer';
  const strengths = profile.mustHaves.slice(0, 3).join(', ') || 'backend systems';
  const referralMessage =
    `Hi — I came across the ${job.title} role at ${job.company} and it looks like a strong fit for my background (${strengths}). ` +
    `I'd love to apply, and wondered if you'd be open to a referral or any quick feedback on my profile before I do. Happy to send my resume across — thanks either way!`;
  const applicationNote =
    `I'm applying because the ${job.title} role lines up closely with my work as a ${role} — particularly around ${strengths}. ` +
    `I'd bring hands-on experience shipping and scaling real systems, and I'm keen to do that at ${job.company}.`;
  return { referralMessage, applicationNote };
}
