import { describe, expect, it } from 'vitest';
import { parsePostedOn } from '../src/sources/workday';

// Workday's list endpoint never returns a date. It returns English prose —
// "Posted Today", "Posted 30+ Days Ago" — so freshness has to be recovered from
// a string. Freshness drives ranking, and a job that parses to null sorts as if
// it had no date at all, so getting this wrong quietly buries good listings.

const NOW = new Date('2026-08-12T10:00:00.000Z');
const day = (s: string | null) => s?.slice(0, 10) ?? null;

describe('parsePostedOn', () => {
  it('reads today and yesterday', () => {
    expect(day(parsePostedOn('Posted Today', NOW))).toBe('2026-08-12');
    expect(day(parsePostedOn('Posted Yesterday', NOW))).toBe('2026-08-11');
  });

  it('reads a day count', () => {
    expect(day(parsePostedOn('Posted 5 Days Ago', NOW))).toBe('2026-08-07');
    expect(day(parsePostedOn('Posted 1 Day Ago', NOW))).toBe('2026-08-11');
  });

  it('treats "30+" as exactly 30 — a floor, not a measurement', () => {
    expect(day(parsePostedOn('Posted 30+ Days Ago', NOW))).toBe('2026-07-13');
  });

  it('is case-insensitive, since the casing is theirs to change', () => {
    expect(day(parsePostedOn('posted today', NOW))).toBe('2026-08-12');
    expect(day(parsePostedOn('POSTED 3 DAYS AGO', NOW))).toBe('2026-08-09');
  });

  it('crosses a month boundary correctly', () => {
    expect(day(parsePostedOn('Posted 20 Days Ago', new Date('2026-03-05T00:00:00Z'))))
      .toBe('2026-02-13');
  });

  // Returning null matters more than guessing. A wrong date is worse than a
  // missing one: it lets a stale posting outrank a fresh one.
  it('returns null rather than inventing a date', () => {
    for (const bad of ['', 'Posted', 'Posted Recently', 'Just Posted', undefined as any, null as any]) {
      expect(parsePostedOn(bad, NOW)).toBeNull();
    }
  });
});
