import { describe, it, expect } from 'vitest';
import { openToIndia, filterOpenToIndia, companyFromToken } from '../src/sources/ats-filter';
import { Job } from '../src/types';

// This gate is what keeps the public ATS boards affordable. They are free and
// unmetered, but scoring is not: the LLM free tier is the binding constraint,
// so every US-only posting admitted here costs a relevant job somewhere else.

describe('openToIndia', () => {
  it('accepts explicit Indian locations', () => {
    for (const l of ['Bengaluru, India', 'Mumbai', 'Gurugram', 'Pune, Maharashtra', 'India']) {
      expect(openToIndia(l), l).toBe(true);
    }
  });

  it('accepts genuinely global remote', () => {
    for (const l of ['Remote (Worldwide)', 'Remote - Global', 'Anywhere', 'Remote']) {
      expect(openToIndia(l), l).toBe(true);
    }
  });

  it('REJECTS country-locked remote — the most common form on these boards', () => {
    for (const l of [
      'Remote - United States',
      'Remote, US',
      'Remote (Canada)',
      'Remote - EMEA',
      'Remote — UK',
      'Remote (Buenos Aires, Argentina)',
      'USA | Remote',
    ]) {
      expect(openToIndia(l), l).toBe(false);
    }
  });

  it('rejects plain foreign offices and empty locations', () => {
    for (const l of ['San Francisco, CA', 'New York', 'Berlin', 'Tokyo', '', '   ']) {
      expect(openToIndia(l), l).toBe(false);
    }
  });

  it('lets India win even when another country is named too', () => {
    // Multi-site postings should not be discarded just because the US is listed.
    expect(openToIndia('Bengaluru, India / Remote - US')).toBe(true);
  });
});

describe('filterOpenToIndia', () => {
  const job = (location: string): Job => ({
    id: 'x:' + location, source: 'greenhouse', title: 'Backend Engineer', company: 'C',
    location, description: '', url: '', salary: null, postedAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
  });

  it('keeps only the reachable ones', () => {
    const out = filterOpenToIndia([
      job('Bengaluru, India'),
      job('Remote - United States'),
      job('Remote (Worldwide)'),
      job('San Francisco, CA'),
    ]);
    expect(out.map((j) => j.location)).toEqual(['Bengaluru, India', 'Remote (Worldwide)']);
  });
});

describe('companyFromToken', () => {
  it('turns a board slug into a readable company name', () => {
    expect(companyFromToken('phonepe')).toBe('Phonepe');
    expect(companyFromToken('job-copilot')).toBe('Job Copilot');
    expect(companyFromToken('mind_tickle')).toBe('Mind Tickle');
  });
});
