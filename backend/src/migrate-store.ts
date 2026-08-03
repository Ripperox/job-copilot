import * as fs from 'fs';
import * as path from 'path';
import { db, LOCAL_USER_ID } from './db';
import { applySchema } from './db/migrate';
import { closePool } from './db/pool';
import { Job, Profile, Score, JobMeta, Outreach } from './types';

// One-off import of the legacy JSON store into Postgres. Idempotent: every write
// is an upsert, so re-running it is safe.

interface LegacyStore {
  profile: Profile | null;
  jobs: Record<string, Job>;
  scores: Record<string, Score>;
  meta: Record<string, JobMeta>;
  outreach: Record<string, Outreach>;
}

async function main() {
  const file = path.join(__dirname, '..', 'data', 'store.json');
  if (!fs.existsSync(file)) {
    console.log('No data/store.json found — nothing to migrate.');
    return;
  }
  const store: LegacyStore = JSON.parse(fs.readFileSync(file, 'utf8'));

  await applySchema();
  await db.ensureUser(LOCAL_USER_ID, 'local@jobcopilot', 'Local User');

  if (store.profile) await db.setProfile(LOCAL_USER_ID, store.profile);

  const jobs = Object.values(store.jobs ?? {});
  for (const job of jobs) await db.upsertJob(job);

  // Scores, meta and outreach reference jobs, so they are written after the jobs
  // exist. Orphans (rows whose job is gone) are skipped rather than failing the run.
  const jobIds = new Set(jobs.map((j) => j.id));

  let scores = 0;
  for (const s of Object.values(store.scores ?? {})) {
    if (!jobIds.has(s.jobId)) continue;
    await db.setScore(LOCAL_USER_ID, s);
    scores++;
  }

  let metas = 0;
  for (const [jobId, m] of Object.entries(store.meta ?? {})) {
    if (!jobIds.has(jobId)) continue;
    await db.setMeta(LOCAL_USER_ID, jobId, m);
    metas++;
  }

  let outreach = 0;
  for (const o of Object.values(store.outreach ?? {})) {
    if (!jobIds.has(o.jobId)) continue;
    await db.setOutreach(LOCAL_USER_ID, o);
    outreach++;
  }

  console.log(
    `Migrated: profile=${store.profile ? 1 : 0} jobs=${jobs.length} ` +
    `scores=${scores} meta=${metas} outreach=${outreach}`,
  );
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exitCode = 1; })
  .finally(closePool);
