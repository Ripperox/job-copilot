import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { Job, Score } from '../src/types';

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

const score = (jobId: string, value = 80): Score => ({
  jobId, score: value, reason: 'good fit', cvVariant: 'Backend', scoredAt: '2026-08-02T00:00:00.000Z',
});

describe('db scores', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('returns undefined for an unscored job', async () => {
    await db.upsertJob(job('a:1'));
    expect(await db.getScore(TEST_USER_ID, 'a:1')).toBeUndefined();
  });

  it('round-trips a score', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1'));
    expect(await db.getScore(TEST_USER_ID, 'a:1')).toEqual(score('a:1'));
  });

  it('overwrites an existing score for the same job', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1', 40));
    await db.setScore(TEST_USER_ID, score('a:1', 90));
    expect((await db.getScore(TEST_USER_ID, 'a:1'))?.score).toBe(90);
  });

  it('lists only jobs this user has not scored', async () => {
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:2'));
    await db.setScore(TEST_USER_ID, score('a:1'));
    const unscored = await db.unscoredJobs(TEST_USER_ID);
    expect(unscored.map((j) => j.id)).toEqual(['a:2']);
  });

  it('isolates scores per user', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1'));
    expect(await db.getScore(OTHER_USER_ID, 'a:1')).toBeUndefined();
    expect((await db.unscoredJobs(OTHER_USER_ID)).map((j) => j.id)).toEqual(['a:1']);
  });
});
