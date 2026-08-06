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

  // countScores is what decides whether a profile save is a user's FIRST one,
  // and so whether to seed their scores in the background. A wrong answer here
  // either leaves a new user staring at an empty list or re-scores on every save.
  it('counts a user\'s scores, and only that user\'s', async () => {
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:2'));
    expect(await db.countScores(TEST_USER_ID)).toBe(0);
    await db.setScore(TEST_USER_ID, score('a:1'));
    await db.setScore(TEST_USER_ID, score('a:2'));
    await db.setScore(OTHER_USER_ID, score('a:1'));
    expect(await db.countScores(TEST_USER_ID)).toBe(2);
    expect(await db.countScores(OTHER_USER_ID)).toBe(1);
  });

  it('isolates scores per user', async () => {
    await db.upsertJob(job('a:1'));
    await db.setScore(TEST_USER_ID, score('a:1'));
    expect(await db.getScore(OTHER_USER_ID, 'a:1')).toBeUndefined();
    expect((await db.unscoredJobs(OTHER_USER_ID)).map((j) => j.id)).toEqual(['a:1']);
  });
});
