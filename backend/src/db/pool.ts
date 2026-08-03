import { Pool, QueryResult, QueryResultRow } from 'pg';

// The only place that reads DATABASE_URL. Tests point it at jobcopilot_test via
// tests/helpers/env.ts, which runs before any module import.
const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/jobcopilot';

// Hosted Postgres (Neon, Supabase, Render) requires TLS, but their certificates
// are not in Node's default trust store, so verification has to be relaxed. Local
// Postgres has no TLS at all — hence keying off the connection string.
const needsSsl = /neon\.tech|supabase|render\.com|amazonaws\.com|sslmode=require/.test(connectionString);

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX) || 10,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
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
