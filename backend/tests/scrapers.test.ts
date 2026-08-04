import { describe, it, expect, afterAll } from 'vitest';
import { closePool } from '../src/db/pool';
import { config } from '../src/config';
import { ProviderError, shouldFailOver, providerStatus } from '../src/scrapers';
import { selectJobRegion } from '../src/sources/scraped';

afterAll(closePool);

describe('scraper failover policy', () => {
  it('fails over on quota, auth and server errors', () => {
    for (const status of [401, 402, 403, 429, 500, 503]) {
      expect(shouldFailOver(new ProviderError('x', status, 'firecrawl')), `status ${status}`).toBe(true);
    }
  });

  it('does NOT fail over on 404 — a missing page is missing everywhere', () => {
    expect(shouldFailOver(new ProviderError('not found', 404, 'firecrawl'))).toBe(false);
  });

  it('does not fail over on other client errors', () => {
    expect(shouldFailOver(new ProviderError('bad request', 400, 'tavily'))).toBe(false);
  });

  it('fails over on network/parse errors that are not ProviderErrors', () => {
    expect(shouldFailOver(new Error('fetch failed'))).toBe(true);
    expect(shouldFailOver(undefined)).toBe(true);
  });
});

describe('job-region selection', () => {
  // Real career pages put the openings BELOW the nav and hero copy. A head
  // truncation showed the model nothing but menus on a page whose first role
  // appeared at character 14,767.
  const nav = 'Home Services About Contact Pricing Blog Login '.repeat(300); // ~14k chars
  const listings = `
### Engineering
Backend Engineer Junior (1-3 Years) Mumbai, India apply
Senior Backend Engineer Senior (5+ Years) Mumbai, India apply
Full Stack Engineer Junior (1-3 Years) Remote full-time apply
DevOps Engineer Junior (1-3 Years) Mumbai, India apply
`.repeat(20);

  it('selects the listings region, not the head of the page', () => {
    const page = nav + listings;
    const picked = selectJobRegion(page, 4000);
    expect(picked).toContain('Backend Engineer');
    expect(picked.length).toBeLessThanOrEqual(4000 + 250); // budget + retained header
  });

  it('returns short pages untouched', () => {
    const short = 'Backend Engineer — apply here';
    expect(selectJobRegion(short, 4000)).toBe(short);
  });

  it('keeps a slice of the header for context', () => {
    const page = `Title: Careers at Acme\n${nav}${listings}`;
    expect(selectJobRegion(page, 3000)).toContain('Careers at Acme');
  });
});

describe('provider availability', () => {
  it('lists every provider in fallback order', () => {
    const names = providerStatus(config).map((p) => p.name);
    expect(names).toEqual(['firecrawl', 'tavily', 'exa', 'jina']);
  });

  it('always leaves a last resort — jina needs no key', () => {
    const bare = { ...config, firecrawlApiKey: '', tavilyApiKey: '', exaApiKey: '', jinaApiKey: '' };
    const usable = providerStatus(bare).filter((p) => p.configured);
    expect(usable.map((p) => p.name)).toEqual(['jina']);
  });

  it('reports keyed providers as configured', () => {
    const keyed = { ...config, firecrawlApiKey: 'fc-test', tavilyApiKey: 'tvly-test', exaApiKey: '' };
    const status = Object.fromEntries(providerStatus(keyed).map((p) => [p.name, p.configured]));
    expect(status.firecrawl).toBe(true);
    expect(status.tavily).toBe(true);
    expect(status.exa).toBe(false);
  });
});
