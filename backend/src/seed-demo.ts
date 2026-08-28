import { db } from './db';
import { config } from './config';
import { applySchema } from './db/migrate';
import { closePool } from './db/pool';
import { scoreJob } from './scoring';
import { Profile } from './types';

// Builds the single pre-scored job shown to visitors who have not added a key.
// Run once (npm run seed:demo) on the OPERATOR's LLM key — every visitor then
// reads the same cached row, so demo cost does not grow with signups.

// A generic sample résumé. Deliberately NOT any real user's, since the demo is
// public: nobody's personal data should be reachable without signing in.
const DEMO_PROFILE: Profile = {
  resumeText: `Backend engineer with ~2 years of experience.
Node.js, TypeScript, Express, PostgreSQL, Redis, REST APIs.
Built real-time services with WebSockets and load-tested them under concurrency.
Comfortable with SQL query optimisation, Docker, and AWS.`,
  roles: ['Backend Engineer', 'Full Stack Engineer'],
  locations: ['Bengaluru', 'Remote'],
  salaryFloor: { amount: null, currency: 'INR', period: 'year' },
  maxYoE: 3,
  mustHaves: ['Node.js', 'PostgreSQL'],
  cvVariants: ['Backend', 'AI', 'Blockchain'],
};

async function main() {
  await applySchema();

  const jobs = await db.allJobs();
  if (!jobs.length) {
    console.error('No jobs in the pool yet — run a fetch first, then re-run this.');
    process.exitCode = 1;
    return;
  }

  // The demo is the first thing a visitor sees, so it has to show the product
  // working — a good match with a substantive reason, not a rejection. Score a
  // handful of plausible candidates and keep the best one.
  const candidates = jobs
    .filter(
      (j) =>
        /\b(backend|back[-\s]?end|full[-\s]?stack|node|software|developer|engineer)\b/i.test(j.title) &&
        // Exclude titles the experience gate will cap at 5 anyway.
        !/\b(senior|sr\.?|lead|principal|staff|head|manager|director|architect)\b/i.test(j.title) &&
        j.description.length > 400,
    )
    .slice(0, 12);

  if (!candidates.length) {
    console.error('No junior-level engineering job with a real description in the pool yet.');
    process.exitCode = 1;
    return;
  }

  let best: { id: string; title: string; company: string; score: number; reason: string; cvVariant: string } | null = null;
  for (const job of candidates) {
    try {
      const r = await scoreJob(job, DEMO_PROFILE, config);
      if (!best || r.score > best.score) {
        best = { id: job.id, title: job.title, company: job.company, ...r };
      }
      if (r.score >= 90) break; // good enough; stop spending quota
    } catch (e) {
      console.error('scoring failed for', job.id, e);
    }
  }

  if (!best) {
    console.error('Could not score any candidate.');
    process.exitCode = 1;
    return;
  }

  await db.setDemoScore(best.id, best.score, best.reason, best.cvVariant);

  console.log(`Demo job cached (best of ${candidates.length} candidates):`);
  console.log(`  ${best.title} @ ${best.company}`);
  console.log(`  score ${best.score} — ${best.reason}`);
}

main()
  .catch((e) => { console.error('Demo seed failed:', e); process.exitCode = 1; })
  .finally(closePool);
