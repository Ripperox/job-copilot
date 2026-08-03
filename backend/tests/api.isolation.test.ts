import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/server';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { signSession, SESSION_COOKIE } from '../src/auth/session';
import { config } from '../src/config';
import { Job, Profile } from '../src/types';

// The highest-priority guarantee of the whole multi-tenant design: one signed-in
// user must never be able to read or mutate another user's data through the API.

const cookieFor = (userId: string) => `${SESSION_COOKIE}=${signSession(userId, config)}`;

const job = (id: string): Job => ({
  id, source: 'test', title: 'Backend Engineer', company: 'Acme', location: 'Remote',
  description: 'd', url: 'u', salary: null, postedAt: null, createdAt: '2026-08-02T00:00:00.000Z',
});

const profile = (resume: string): Profile => ({
  resumeText: resume,
  roles: ['Backend Engineer'],
  locations: ['Remote'],
  salaryFloorLPA: 15,
  maxYoE: 3,
  mustHaves: ['Node'],
  cvVariants: ['Backend'],
});

describe('API tenant isolation', () => {
  beforeEach(async () => {
    await resetDb();
    await db.upsertJob(job('a:1'));
  });
  afterAll(closePool);

  it('rejects unauthenticated requests to every protected route', async () => {
    const routes: [string, string][] = [
      ['get', '/api/profile'],
      ['put', '/api/profile'],
      ['get', '/api/jobs'],
      ['patch', '/api/jobs/a:1'],
      ['get', '/api/jobs/a:1/outreach'],
      ['post', '/api/jobs/a:1/outreach'],
      ['post', '/api/fetch'],
      ['post', '/api/rescore'],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it('leaves health and auth/me open, with me returning 401 when signed out', async () => {
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/auth/me').expect(401);
  });

  it('identifies the signed-in user on /api/auth/me', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(res.body.id).toBe(TEST_USER_ID);
    expect(res.body.email).toBe('test@example.com');
  });

  it('ignores a forged session cookie', async () => {
    await request(app)
      .get('/api/profile')
      .set('Cookie', `${SESSION_COOKIE}=eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJoYWNrZXIifQ.bogus`)
      .expect(401);
  });

  it('keeps profiles private per user', async () => {
    await request(app)
      .put('/api/profile')
      .set('Cookie', cookieFor(TEST_USER_ID))
      .send(profile('user A resume'))
      .expect(200);

    const mine = await request(app).get('/api/profile').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(mine.body.resumeText).toBe('user A resume');

    const theirs = await request(app).get('/api/profile').set('Cookie', cookieFor(OTHER_USER_ID)).expect(200);
    expect(theirs.body).toBeNull();
  });

  it('keeps scores and pipeline state private per user', async () => {
    await db.setScore(TEST_USER_ID, {
      jobId: 'a:1', score: 91, reason: 'strong', cvVariant: 'Backend', scoredAt: '2026-08-02T00:00:00.000Z',
    });
    await request(app)
      .patch('/api/jobs/a:1')
      .set('Cookie', cookieFor(TEST_USER_ID))
      .send({ status: 'applied', notes: 'private note' })
      .expect(200);

    const mine = await request(app).get('/api/jobs').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(mine.body[0]).toMatchObject({ id: 'a:1', score: 91, status: 'applied', notes: 'private note' });

    // Same shared job, but none of user A's private overlay.
    const theirs = await request(app).get('/api/jobs').set('Cookie', cookieFor(OTHER_USER_ID)).expect(200);
    expect(theirs.body[0]).toMatchObject({ id: 'a:1', score: null, status: 'new', notes: '' });
  });

  it("one user's PATCH cannot alter another user's pipeline", async () => {
    await request(app)
      .patch('/api/jobs/a:1')
      .set('Cookie', cookieFor(OTHER_USER_ID))
      .send({ status: 'rejected', notes: 'B wrote this' })
      .expect(200);

    expect((await db.getMeta(TEST_USER_ID, 'a:1')).status).toBe('new');
    expect((await db.getMeta(OTHER_USER_ID, 'a:1')).status).toBe('rejected');
  });

  it('keeps outreach drafts private per user', async () => {
    await db.setOutreach(TEST_USER_ID, {
      jobId: 'a:1',
      referralMessage: 'A private draft',
      applicationNote: 'note',
      targets: [],
      cvVariant: 'Backend',
      generatedAt: '2026-08-02T00:00:00.000Z',
    });

    const mine = await request(app).get('/api/jobs/a:1/outreach').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    expect(mine.body.referralMessage).toBe('A private draft');

    const theirs = await request(app).get('/api/jobs/a:1/outreach').set('Cookie', cookieFor(OTHER_USER_ID)).expect(200);
    expect(theirs.body).toBeNull();
  });

  it('logout clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toContain(SESSION_COOKIE);
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('deleting an account removes its data but leaves the shared job pool', async () => {
    await db.setScore(TEST_USER_ID, {
      jobId: 'a:1', score: 80, reason: 'r', cvVariant: 'Backend', scoredAt: '2026-08-02T00:00:00.000Z',
    });
    await request(app).delete('/api/auth/account').set('Cookie', cookieFor(TEST_USER_ID)).expect(200);

    expect(await db.getUser(TEST_USER_ID)).toBeUndefined();
    expect(await db.getScore(TEST_USER_ID, 'a:1')).toBeUndefined();
    expect(await db.allJobs()).toHaveLength(1); // shared pool untouched
  });
});
