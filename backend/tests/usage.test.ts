import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { bump, periodFor, resetsAt, quotas, summary } from '../src/usage';
import { closePool } from '../src/db/pool';
import { resetDb } from './helpers/db';

describe('usage windows', () => {
  it('buckets daily usage by UTC date and monthly by UTC month', () => {
    const at = new Date('2026-08-07T23:30:00.000Z');
    expect(periodFor('day', at)).toBe('2026-08-07');
    expect(periodFor('month', at)).toBe('2026-08');
  });

  it('rolls the daily bucket at midnight UTC, not at local midnight', () => {
    // The operator is in IST. 23:30 UTC is already tomorrow locally, and a
    // bucket that followed local time would reset ~5.5h before the provider's
    // counter does — reporting headroom that is not there.
    expect(resetsAt('day', new Date('2026-08-07T23:30:00.000Z'))).toBe('2026-08-08T00:00:00.000Z');
  });

  it('rolls the monthly bucket over a year boundary', () => {
    expect(resetsAt('month', new Date('2026-12-31T12:00:00.000Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('gives every quota a label and a note, so nothing renders as a bare id', () => {
    for (const q of quotas()) {
      expect(q.label.length).toBeGreaterThan(0);
      expect(q.note.length).toBeGreaterThan(0);
    }
  });
});

describe('usage counters', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('starts every known api at zero rather than omitting it', async () => {
    const rows = await summary();
    expect(rows.length).toBe(quotas().length);
    expect(rows.every((r) => r.used === 0)).toBe(true);
  });

  it('accumulates repeated bumps into one bucket', async () => {
    await bump('groq');
    await bump('groq');
    await bump('groq', 3);
    const groq = (await summary()).find((r) => r.name === 'groq')!;
    expect(groq.used).toBe(5);
  });

  it('computes remaining and fraction against the limit', async () => {
    const limit = quotas().find((q) => q.name === 'gemini')!.limit!;
    await bump('gemini', 10);
    const g = (await summary()).find((r) => r.name === 'gemini')!;
    expect(g.remaining).toBe(limit - 10);
    expect(g.fraction).toBeCloseTo(10 / limit);
  });

  it('never reports a fraction above 1, so an overspent bar cannot overflow', async () => {
    const limit = quotas().find((q) => q.name === 'jsearch')!.limit!;
    await bump('jsearch', limit + 50);
    const j = (await summary()).find((r) => r.name === 'jsearch')!;
    expect(j.fraction).toBe(1);
    expect(j.remaining).toBe(0);
    // The raw count stays truthful even though the bar is clamped.
    expect(j.used).toBe(limit + 50);
  });

  it('leaves uncapped apis without a bar instead of inventing a limit', async () => {
    await bump('greenhouse', 4);
    const gh = (await summary()).find((r) => r.name === 'greenhouse')!;
    expect(gh.used).toBe(4);
    expect(gh.limit).toBeNull();
    expect(gh.fraction).toBeNull();
    expect(gh.remaining).toBeNull();
  });

  it('keeps each api\'s count separate', async () => {
    await bump('groq', 2);
    await bump('adzuna', 7);
    const rows = await summary();
    expect(rows.find((r) => r.name === 'groq')!.used).toBe(2);
    expect(rows.find((r) => r.name === 'adzuna')!.used).toBe(7);
    expect(rows.find((r) => r.name === 'cerebras')!.used).toBe(0);
  });

  it('ignores a zero or negative bump', async () => {
    await bump('groq', 0);
    await bump('groq', -5);
    expect((await summary()).find((r) => r.name === 'groq')!.used).toBe(0);
  });
});
