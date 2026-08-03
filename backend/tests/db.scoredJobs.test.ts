import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { Job } from '../src/types';

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

const score = (jobId: string, value: number) => ({
  jobId, score: value, reason: 'r', cvVariant: 'Backend', scoredAt: '2026-08-02T00:00:00.000Z',
});

describe('db scoredJobs', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('merges score and meta onto each job, with defaults when absent', async () => {
    await db.upsertJob(job('a:1'));
    const [row] = await db.scoredJobs(TEST_USER_ID);
    expect(row).toMatchObject({
      id: 'a:1', score: null, reason: null, cvVariant: null,
      status: 'new', notes: '', dismissed: false,
    });
  });

  it('sorts by score descending with unscored jobs last', async () => {
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:2'));
    await db.upsertJob(job('a:3'));
    await db.setScore(TEST_USER_ID, score('a:1', 40));
    await db.setScore(TEST_USER_ID, score('a:2', 95));
    const ids = (await db.scoredJobs(TEST_USER_ID)).map((j) => j.id);
    expect(ids).toEqual(['a:2', 'a:1', 'a:3']);
  });

  it('reflects this user only', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1', 90));
    await db.setMeta(TEST_USER_ID, 'a:1', { status: 'applied' });
    const [mine] = await db.scoredJobs(TEST_USER_ID);
    const [theirs] = await db.scoredJobs(OTHER_USER_ID);
    expect(mine.score).toBe(90);
    expect(mine.status).toBe('applied');
    expect(theirs.score).toBeNull();
    expect(theirs.status).toBe('new');
  });

  it('getScoredJob returns one row, or undefined for an unknown id', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1', 70));
    expect((await db.getScoredJob(TEST_USER_ID, 'a:1'))?.score).toBe(70);
    expect(await db.getScoredJob(TEST_USER_ID, 'nope:1')).toBeUndefined();
  });
});
