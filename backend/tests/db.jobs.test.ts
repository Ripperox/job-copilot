import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb } from './helpers/db';
import { Job } from '../src/types';

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  source: 'test',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Bengaluru',
  description: 'Node and Postgres',
  url: `https://example.com/${id}`,
  salary: '18 LPA',
  postedAt: '2026-08-01',
  createdAt: '2026-08-02T00:00:00.000Z',
  ...over,
});

describe('db jobs', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('returns true when inserting a new job, false when it already exists', async () => {
    expect(await db.upsertJob(job('a:1'))).toBe(true);
    expect(await db.upsertJob(job('a:1'))).toBe(false);
  });

  it('updates fields on re-upsert without duplicating the row', async () => {
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:1', { title: 'Senior Backend Engineer' }));
    const all = await db.allJobs();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Senior Backend Engineer');
  });

  it('round-trips every field, including nulls', async () => {
    await db.upsertJob(job('a:2', { salary: null, postedAt: null }));
    const [got] = await db.allJobs();
    expect(got).toEqual(job('a:2', { salary: null, postedAt: null }));
  });

  it('returns all jobs', async () => {
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:2'));
    expect(await db.allJobs()).toHaveLength(2);
  });
});
