import * as fs from 'fs';
import * as path from 'path';
import { pool } from './pool';

// Applies schema.sql. Idempotent, so it is safe to call on every server boot.
export async function applySchema(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
