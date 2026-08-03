import { Pool, QueryResult, QueryResultRow } from 'pg';

// The only place that reads DATABASE_URL. Tests point it at jobcopilot_test via
// tests/helpers/env.ts, which runs before any module import.
const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/jobcopilot';

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
