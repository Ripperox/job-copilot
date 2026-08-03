import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { Job } from '../src/types';

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

describe('db job meta', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('returns the default meta when no row exists', async () => {
    await db.upsertJob(job('a:1'));
    expect(await db.getMeta(TEST_USER_ID, 'a:1')).toEqual({
      status: 'new', notes: '', dismissed: false,
    });
  });

  it('applies a partial patch and leaves other fields at their defaults', async () => {
    await db.upsertJob(job('a:1'));
    const next = await db.setMeta(TEST_USER_ID, 'a:1', { status: 'applied' });
    expect(next).toEqual({ status: 'applied', notes: '', dismissed: false });
  });

  it('merges successive patches instead of overwriting the row', async () => {
    await db.upsertJob(job('a:1'));
    await db.setMeta(TEST_USER_ID, 'a:1', { status: 'outreach' });
    await db.setMeta(TEST_USER_ID, 'a:1', { notes: 'emailed the EM' });
    expect(await db.getMeta(TEST_USER_ID, 'a:1')).toEqual({
      status: 'outreach', notes: 'emailed the EM', dismissed: false,
    });
  });

  it('records dismissal', async () => {
    await db.upsertJob(job('a:1'));
    await db.setMeta(TEST_USER_ID, 'a:1', { dismissed: true });
    expect((await db.getMeta(TEST_USER_ID, 'a:1')).dismissed).toBe(true);
  });

  it('isolates meta per user', async () => {
    await db.upsertJob(job('a:1'));
    await db.setMeta(TEST_USER_ID, 'a:1', { status: 'applied' });
    expect((await db.getMeta(OTHER_USER_ID, 'a:1')).status).toBe('new');
  });
});
