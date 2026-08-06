import { describe, it, expect } from 'vitest';
import { classify } from '../src/health';

// The whole point of this module is telling "wait, it resets" apart from "fix
// the key". Collapsing those into "error" is what made a rate-limit bug take a
// day to find.
describe('classify', () => {
  it('reads a monthly quota as quota, not a generic error', () => {
    const r = classify('jsearch 429: You have exceeded the MONTHLY quota for Requests on your current plan, BASIC');
    expect(r.state).toBe('quota');
    expect(r.detail).toMatch(/billing date/i);
  });

  it('reads a plain 429 as quota', () => {
    expect(classify('Groq 429: Rate limit reached for model').state).toBe('quota');
  });

  it('reads a rejected key as auth, which needs a human', () => {
    for (const m of [
      'Gemini 400: API key not valid. Please pass a valid API key.',
      'Greenhouse 401: unauthorized',
      'firecrawl 403: Forbidden',
    ]) {
      expect(classify(m).state, m).toBe('auth');
    }
  });

  it('reads 402 as auth — waiting will never fix an unpaid account', () => {
    expect(classify('Cerebras 402: Payment required to access this resource').state).toBe('auth');
  });

  it('falls back to error, keeping the message short enough to display', () => {
    const r = classify('fetch failed: ECONNRESET ' + 'x'.repeat(500));
    expect(r.state).toBe('error');
    expect(r.detail.length).toBeLessThanOrEqual(160);
  });
});
