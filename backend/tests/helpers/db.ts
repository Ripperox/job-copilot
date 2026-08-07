import { pool } from '../../src/db/pool';
import { applySchema } from '../../src/db/migrate';

export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
export const OTHER_USER_ID = '00000000-0000-0000-0000-000000000002';

// Fresh, empty schema with two users present. Called in beforeEach.
// applySchema() runs FIRST so the TRUNCATE below has tables to act on.
export async function resetDb(): Promise<void> {
  await applySchema();
  await pool.query('TRUNCATE users, jobs, profiles, scores, job_meta, outreach, api_usage CASCADE');
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3), ($4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, 'test@example.com', 'Test User', OTHER_USER_ID, 'other@example.com', 'Other User'],
  );
}
