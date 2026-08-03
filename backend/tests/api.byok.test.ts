import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/server';
import { db } from '../src/db';
import { closePool, pool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { signSession, SESSION_COOKIE } from '../src/auth/session';
import { config } from '../src/config';
import { encryptSecret } from '../src/crypto';
import { llmConfigForUser, detectProvider } from '../src/user-llm';
import { Job } from '../src/types';

// One pool teardown for the whole file — a per-describe afterAll would close the
// pool before the later describe blocks run.
afterAll(closePool);

const cookieFor = (userId: string) => `${SESSION_COOKIE}=${signSession(userId, config)}`;

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

const FAKE_KEY = 'AQ.FakeKeyForTests_abcdefghijklmnop';

// Writes a key straight to the DB, bypassing the live-validation the PUT route
// does (these tests must not call Gemini).
async function storeKey(userId: string, key = FAKE_KEY) {
  await db.setUserKey(userId, encryptSecret(key, config.keyEncryptionSecret), 'AQ.Fa…mnop', 'gemini');
}

describe('bring-your-own-key', () => {
  beforeEach(async () => {
    await resetDb();
    await pool.query('TRUNCATE user_keys, demo_score CASCADE');
    await db.upsertJob(job('a:1'));
  });

  it('requires auth for every key route', async () => {
    await request(app).get('/api/key').expect(401);
    await request(app).put('/api/key').send({ apiKey: FAKE_KEY }).expect(401);
    await request(app).delete('/api/key').expect(401);
  });

  it('reports no key for a fresh account', async () => {
    const res = await request(app).get('/api/key').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(res.body).toEqual({ hasKey: false, mask: null, provider: null });
  });

  it('never returns the raw key, only a mask', async () => {
    await storeKey(TEST_USER_ID);
    const res = await request(app).get('/api/key').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(res.body.hasKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
  });

  it('rejects an empty key without calling the provider', async () => {
    await request(app)
      .put('/api/key')
      .set('Cookie', cookieFor(TEST_USER_ID))
      .send({ apiKey: '   ' })
      .expect(400);
  });

  it('deletes a stored key', async () => {
    await storeKey(TEST_USER_ID);
    await request(app).delete('/api/key').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(await db.getUserKeyRecord(TEST_USER_ID)).toBeUndefined();
  });

  it('keeps keys isolated between users', async () => {
    await storeKey(TEST_USER_ID);
    const theirs = await request(app).get('/api/key').set('Cookie', cookieFor(OTHER_USER_ID)).expect(200);
    expect(theirs.body).toEqual({ hasKey: false, mask: null, provider: null });
  });

  it('resolves the user own key for scoring, and no provider key without one', async () => {
    const none = await llmConfigForUser(TEST_USER_ID, config);
    expect(none.hasKey).toBe(false);
    // Critically: it must NOT silently fall back to the operator's keys.
    expect(none.config.geminiApiKey).toBe('');
    expect(none.config.groqApiKey).toBe('');
    expect(none.config.anthropicApiKey).toBe('');

    await storeKey(TEST_USER_ID);
    const mine = await llmConfigForUser(TEST_USER_ID, config);
    expect(mine.hasKey).toBe(true);
    expect(mine.config.geminiApiKey).toBe(FAKE_KEY);
  });

  it('infers the provider from the key prefix', () => {
    expect(detectProvider('gsk_abc123')).toBe('groq');
    expect(detectProvider('sk-ant-abc123')).toBe('anthropic');
    expect(detectProvider('AQ.Ab8xyz')).toBe('gemini');
    expect(detectProvider('AIzaSyAbc')).toBe('gemini');
  });

  it('routes a groq key to groq only, leaving other providers unset', async () => {
    const groqKey = 'gsk_testkey_abcdefghijklmnop';
    await db.setUserKey(
      TEST_USER_ID, encryptSecret(groqKey, config.keyEncryptionSecret), 'gsk_t…mnop', 'groq',
    );
    const r = await llmConfigForUser(TEST_USER_ID, config);
    expect(r.provider).toBe('groq');
    expect(r.config.groqApiKey).toBe(groqKey);
    expect(r.config.geminiApiKey).toBe('');
    expect(r.config.anthropicApiKey).toBe('');
  });

  it('treats an undecryptable stored key as no key', async () => {
    await db.setUserKey(TEST_USER_ID, 'corrupt-blob', 'xx', 'gemini');
    const r = await llmConfigForUser(TEST_USER_ID, config);
    expect(r.hasKey).toBe(false);
    expect(r.config.geminiApiKey).toBe('');
  });

  it('drops the stored key when the account is deleted', async () => {
    await storeKey(TEST_USER_ID);
    await request(app).delete('/api/auth/account').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(await db.getUserKeyRecord(TEST_USER_ID)).toBeUndefined();
  });
});

describe('the free demo', () => {
  beforeEach(async () => {
    await resetDb();
    await pool.query('TRUNCATE user_keys, demo_score CASCADE');
    await db.upsertJob(job('a:1'));
    await db.upsertJob(job('a:2'));
  });

  it('is reachable without signing in', async () => {
    await db.setDemoScore('a:1', 88, 'strong fit', 'Backend');
    const res = await request(app).get('/api/demo').expect(200);
    expect(res.body.id).toBe('a:1');
    expect(res.body.score).toBe(88);
  });

  it('returns exactly one job, never the whole pool', async () => {
    await db.setDemoScore('a:1', 88, 'strong fit', 'Backend');
    const res = await request(app).get('/api/demo').expect(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.id).toBe('a:1');
  });

  it('returns null before a demo job has been seeded', async () => {
    const res = await request(app).get('/api/demo').expect(200);
    expect(res.body).toBeNull();
  });

  it('exposes no per-user state', async () => {
    await db.setDemoScore('a:1', 88, 'strong fit', 'Backend');
    await db.setMeta(TEST_USER_ID, 'a:1', { status: 'applied', notes: 'private' });
    const res = await request(app).get('/api/demo').expect(200);
    expect(res.body.status).toBe('new');
    expect(res.body.notes).toBe('');
    expect(JSON.stringify(res.body)).not.toContain('private');
  });
});
