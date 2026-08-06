import { query } from './db/pool';

// Source health tracking.
//
// Every failure in this system used to go to stderr and nowhere else, so three
// job sources could sit monthly-quota-dead for hours while the dashboard showed
// a healthy-looking pool of stale rows. The only way to find out was to read
// Render's logs. That is not a product.

export type HealthState = 'ok' | 'quota' | 'auth' | 'error' | 'idle';
export type HealthKind = 'job' | 'llm' | 'scraper';

export interface SourceHealth {
  name: string;
  kind: HealthKind;
  state: HealthState;
  detail: string | null;
  items: number;
  /** When a rate-limited provider says it will be usable again. */
  retryAfter: string | null;
  checkedAt: string;
}

/**
 * Classify a failure into something a human can act on.
 *
 * The distinction that matters: "wait" (quota, resets on its own) versus "fix
 * something" (auth, needs a new key) versus "unknown". Collapsing those into
 * "error" is what made the LLM rate-limit bug take a day to find.
 */
export function classify(message: string): { state: HealthState; detail: string } {
  const m = message.toLowerCase();
  if (/monthly quota|quota for (requests|jobs)|exceeded the .*quota/.test(m)) {
    return { state: 'quota', detail: 'Monthly quota exhausted — resets on the plan billing date' };
  }
  if (/429|rate limit|too many requests|resource_exhausted/.test(m)) {
    return { state: 'quota', detail: 'Rate limited' };
  }
  if (/401|403|unauthorized|forbidden|api key|invalid.*key|permission denied/.test(m)) {
    return { state: 'auth', detail: 'Key rejected — needs a valid credential' };
  }
  if (/402|payment required|billing/.test(m)) {
    return { state: 'auth', detail: 'Payment required — the account cannot use this model' };
  }
  return { state: 'error', detail: message.slice(0, 160) };
}

/** Record one source's outcome. Never throws — telemetry must not break a run. */
export async function record(
  name: string,
  kind: HealthKind,
  state: HealthState,
  detail: string | null,
  items = 0,
  retryAfterMs?: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO source_health (name, kind, state, detail, items, retry_after, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (name) DO UPDATE SET
         kind = EXCLUDED.kind, state = EXCLUDED.state, detail = EXCLUDED.detail,
         items = EXCLUDED.items, retry_after = EXCLUDED.retry_after,
         checked_at = EXCLUDED.checked_at`,
      [
        name,
        kind,
        state,
        detail,
        items,
        retryAfterMs && retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs) : null,
      ],
    );
  } catch (e: any) {
    console.error(`[health] could not record ${name}:`, e.message);
  }
}

export async function recordOk(name: string, kind: HealthKind, items: number): Promise<void> {
  return record(name, kind, 'ok', null, items);
}

export async function recordFailure(
  name: string,
  kind: HealthKind,
  message: string,
  retryAfterMs?: number,
): Promise<void> {
  const { state, detail } = classify(message);
  return record(name, kind, state, detail, 0, retryAfterMs);
}

export async function all(): Promise<SourceHealth[]> {
  const { rows } = await query<{
    name: string; kind: string; state: string; detail: string | null;
    items: number; retry_after: Date | null; checked_at: Date;
  }>('SELECT * FROM source_health ORDER BY kind, name');
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind as HealthKind,
    state: r.state as HealthState,
    detail: r.detail,
    items: Number(r.items),
    retryAfter: r.retry_after ? new Date(r.retry_after).toISOString() : null,
    checkedAt: new Date(r.checked_at).toISOString(),
  }));
}
