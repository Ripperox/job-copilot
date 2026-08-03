import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { Job, Outreach } from '../src/types';

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

const outreach = (jobId: string): Outreach => ({
  jobId,
  referralMessage: 'Hi — saw the backend role...',
  applicationNote: 'I am applying because...',
  targets: [{ title: 'Engineering Manager', searchUrl: 'https://linkedin.com/search?q=EM' }],
  cvVariant: 'Backend',
  generatedAt: '2026-08-02T00:00:00.000Z',
});

describe('db outreach', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('returns undefined when nothing has been generated', async () => {
    await db.upsertJob(job('a:1'));
    expect(await db.getOutreach(TEST_USER_ID, 'a:1')).toBeUndefined();
  });

  it('round-trips outreach including the jsonb targets array', async () => {
    await db.upsertJob(job('a:1'));
    await db.setOutreach(TEST_USER_ID, outreach('a:1'));
    expect(await db.getOutreach(TEST_USER_ID, 'a:1')).toEqual(outreach('a:1'));
  });

  it('replaces existing outreach on regenerate', async () => {
    await db.upsertJob(job('a:1'));
    await db.setOutreach(TEST_USER_ID, outreach('a:1'));
    await db.setOutreach(TEST_USER_ID, { ...outreach('a:1'), referralMessage: 'v2' });
    expect((await db.getOutreach(TEST_USER_ID, 'a:1'))?.referralMessage).toBe('v2');
  });

  it('isolates outreach per user', async () => {
    await db.upsertJob(job('a:1'));
    await db.setOutreach(TEST_USER_ID, outreach('a:1'));
    expect(await db.getOutreach(OTHER_USER_ID, 'a:1')).toBeUndefined();
  });
});
