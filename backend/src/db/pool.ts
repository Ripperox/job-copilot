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

// Pin search_path on every new physical connection.
//
// Hosted poolers (Neon, PgBouncer) reuse backends between clients, so a
// session-level `SET search_path` left behind by someone else leaks into ours.
// A pg_dump restore sets it to EMPTY, after which every unqualified query fails
// with "relation does not exist" even though the tables are right there in
// public — which is exactly what happened provisioning this database.
//
// This runs as a query after connecting rather than as an `options` startup
// parameter, because Neon's pooler rejects unsupported startup parameters.
pool.on('connect', (client) => {
  client.query('SET search_path TO public').catch((e) => {
    console.error('could not pin search_path on new connection:', e.message);
  });
});

// A pooled client erroring in the background must not take the process down.
pool.on('error', (e) => {
  console.error('idle postgres client error:', e.message);
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
