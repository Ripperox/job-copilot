import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, closePool } from '../src/db/pool';
import { db } from '../src/db';
import { resetDb } from './helpers/db';

// The queue is what makes scraping affordable: a page that cannot yield must
// stop competing for the Firecrawl/LLM budget with pages that can, without ever
// being permanently dropped.

describe('scrape queue', () => {
  beforeEach(async () => {
    await resetDb();
    await pool.query('DELETE FROM scrape_targets');
  });
  afterAll(closePool);

  const A = 'https://a.example/careers';
  const B = 'https://b.example/careers';
  const C = 'https://c.example/careers';

  it('registers targets idempotently and disables ones dropped from the list', async () => {
    await db.syncScrapeTargets([A, B]);
    expect((await db.scrapeQueueStatus()).enabled).toBe(2);

    // Re-syncing the same list must not duplicate or reset anything.
    await db.syncScrapeTargets([A, B]);
    expect((await db.scrapeQueueStatus()).enabled).toBe(2);

    // Dropping B disables it rather than deleting — its history survives.
    await db.syncScrapeTargets([A]);
    const st = await db.scrapeQueueStatus();
    expect(st.enabled).toBe(1);
    expect(st.total).toBe(2);
  });

  it('hands out the least recently scraped first, and never more than asked', async () => {
    await db.syncScrapeTargets([A, B, C]);
    const first = await db.dueScrapeTargets(2);
    expect(first.length).toBe(2);

    await db.recordScrapeResult(first[0], 5, 3);
    await db.recordScrapeResult(first[1], 5, 3);

    // Those two are now in cooldown, so the untouched one comes next.
    const next = await db.dueScrapeTargets(3);
    expect(next).toEqual([C]);
  });

  it('backs a barren target off exponentially, and resets it the moment it yields', async () => {
    await db.syncScrapeTargets([A]);

    const dueIn = async () => {
      const { rows } = await pool.query<{ h: string }>(
        "SELECT EXTRACT(EPOCH FROM (due_at - now()))/3600 AS h FROM scrape_targets WHERE url = $1",
        [A],
      );
      return Number(rows[0].h);
    };

    await db.recordScrapeResult(A, 0, 3); // 1st empty -> 3h * 2^1
    expect(await dueIn()).toBeGreaterThan(5);
    await db.recordScrapeResult(A, 0, 3); // 2nd empty -> 3h * 2^2
    expect(await dueIn()).toBeGreaterThan(11);

    // A single successful scrape puts it straight back on the fast cycle.
    await db.recordScrapeResult(A, 7, 3);
    const h = await dueIn();
    expect(h).toBeGreaterThan(2);
    expect(h).toBeLessThan(4);
  });

  it('keeps a running total of what each target has produced', async () => {
    await db.syncScrapeTargets([A]);
    await db.recordScrapeResult(A, 4, 3);
    await db.recordScrapeResult(A, 6, 3);
    const { rows } = await pool.query('SELECT total_roles, last_roles FROM scrape_targets WHERE url = $1', [A]);
    expect(Number(rows[0].total_roles)).toBe(10);
    expect(Number(rows[0].last_roles)).toBe(6);
  });

  it('records an error without leaving the target permanently due', async () => {
    await db.syncScrapeTargets([A]);
    await db.recordScrapeResult(A, 0, 3, 'firecrawl 502');
    expect(await db.dueScrapeTargets(5)).toEqual([]);
    const { rows } = await pool.query('SELECT last_error FROM scrape_targets WHERE url = $1', [A]);
    expect(rows[0].last_error).toBe('firecrawl 502');
  });
});
