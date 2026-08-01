import * as fs from 'fs';
import * as path from 'path';
import { Job, Profile, Score, Outreach, JobMeta } from './types';

const DEFAULT_META: JobMeta = { status: 'new', notes: '', dismissed: false };

// Simple JSON-file store. Deliberately zero native deps so it runs anywhere
// (no better-sqlite3 build step). Abstracted behind `db` so we can swap in
// SQLite/Postgres later without touching the rest of the app.

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

interface Store {
  profile: Profile | null;
  jobs: Record<string, Job>;
  scores: Record<string, Score>;
  meta: Record<string, JobMeta>;
  outreach: Record<string, Outreach>;
}

function emptyStore(): Store {
  return { profile: null, jobs: {}, scores: {}, meta: {}, outreach: {} };
}

let store: Store = emptyStore();

function load(): void {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      store = { ...emptyStore(), ...parsed };
      // Migrate the old `applied: boolean` map to the new `meta` schema.
      if (parsed.applied && typeof parsed.applied === 'object') {
        for (const [jobId, applied] of Object.entries(parsed.applied)) {
          if (!store.meta[jobId]) {
            store.meta[jobId] = { status: applied ? 'applied' : 'new', notes: '', dismissed: false };
          }
        }
        delete (store as unknown as { applied?: unknown }).applied;
      }
    }
  } catch (e) {
    console.error('Failed to load store, starting empty:', e);
    store = emptyStore();
  }
}

function persist(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

load();

export const db = {
  getProfile(): Profile | null {
    return store.profile;
  },
  setProfile(p: Profile): Profile {
    store.profile = p;
    persist();
    return p;
  },
  upsertJob(job: Job): boolean {
    const isNew = !store.jobs[job.id];
    store.jobs[job.id] = job;
    if (isNew) persist();
    return isNew;
  },
  allJobs(): Job[] {
    return Object.values(store.jobs);
  },
  getScore(jobId: string): Score | undefined {
    return store.scores[jobId];
  },
  setScore(s: Score): void {
    store.scores[s.jobId] = s;
    persist();
  },
  unscoredJobs(): Job[] {
    return Object.values(store.jobs).filter((j) => !store.scores[j.id]);
  },
  getMeta(jobId: string): JobMeta {
    return store.meta[jobId] ?? { ...DEFAULT_META };
  },
  setMeta(jobId: string, patch: Partial<JobMeta>): JobMeta {
    const current = store.meta[jobId] ?? { ...DEFAULT_META };
    const next: JobMeta = { ...current, ...patch };
    store.meta[jobId] = next;
    persist();
    return next;
  },
  getOutreach(jobId: string): Outreach | undefined {
    return store.outreach[jobId];
  },
  setOutreach(o: Outreach): void {
    store.outreach[o.jobId] = o;
    persist();
  },
};
