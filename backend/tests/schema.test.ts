import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, closePool } from '../src/db/pool';
import { applySchema } from '../src/db/migrate';
import { resetDb, TEST_USER_ID } from './helpers/db';

describe('schema', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('creates every expected table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(['job_meta', 'jobs', 'outreach', 'profiles', 'scores', 'users'].sort());
  });

  it('is idempotent — applying twice does not throw', async () => {
    await expect(applySchema()).resolves.toBeUndefined();
    await expect(applySchema()).resolves.toBeUndefined();
  });

  it('cascades deletes from users to per-user rows', async () => {
    await pool.query(
      `INSERT INTO jobs (id, source, title, company, location, description, url, created_at)
       VALUES ('t:1','test','T','C','L','D','u','2026-01-01')`,
    );
    await pool.query(
      `INSERT INTO scores (user_id, job_id, score, reason, cv_variant, scored_at)
       VALUES ($1,'t:1',50,'r','Backend','2026-01-01')`,
      [TEST_USER_ID],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [TEST_USER_ID]);
    const { rowCount } = await pool.query('SELECT 1 FROM scores WHERE user_id = $1', [TEST_USER_ID]);
    expect(rowCount).toBe(0);
  });
});
