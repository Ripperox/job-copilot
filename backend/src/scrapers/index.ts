import { Config, config as defaultConfig } from '../config';
import { allProviders } from './providers';
import { ScrapeProvider, ScrapeResult, SearchResult, shouldFailOver } from './types';

export * from './types';
export { allProviders } from './providers';

// Tries each configured provider in order until one succeeds. The point is that
// running out of Firecrawl credits mid-month degrades to Tavily, then Exa, then
// keyless Jina — rather than the scraping source simply going dark.
//
// A provider is skipped when unconfigured, and we only move on for failures that
// the next provider could plausibly survive (quota/auth/5xx). A 404 is returned
// as-is: the page is missing everywhere.

export interface ChainOutcome<T> {
  result: T;
  provider: string;
  /** Providers that were tried and failed, with why. */
  attempts: { provider: string; error: string }[];
}

async function runChain<T>(
  providers: ScrapeProvider[],
  label: string,
  fn: (p: ScrapeProvider) => Promise<T> | undefined,
): Promise<ChainOutcome<T>> {
  const attempts: { provider: string; error: string }[] = [];

  for (const provider of providers) {
    if (!provider.configured()) continue;
    const call = fn(provider);
    if (!call) continue; // provider does not support this operation
    try {
      return { result: await call, provider: provider.name, attempts };
    } catch (e: unknown) {
      const message = String((e as Error)?.message ?? e).slice(0, 200);
      attempts.push({ provider: provider.name, error: message });
      if (!shouldFailOver(e)) throw e; // e.g. a 404 — the next provider will not help
      console.error(`[scraper] ${provider.name} failed on ${label}: ${message} — falling through`);
    }
  }

  const tried = attempts.map((a) => a.provider).join(', ') || 'none configured';
  throw new Error(`All scraping providers failed for ${label} (tried: ${tried})`);
}

export function scrapePage(url: string, config: Config = defaultConfig): Promise<ChainOutcome<ScrapeResult>> {
  return runChain(allProviders(config), `scrape ${url}`, (p) => p.scrape(url));
}

export function searchWeb(
  query: string,
  limit = 10,
  config: Config = defaultConfig,
): Promise<ChainOutcome<SearchResult[]>> {
  return runChain(allProviders(config), `search "${query}"`, (p) => p.search?.(query, limit));
}

/** Which providers are usable right now — surfaced on /api/health. */
export function providerStatus(config: Config = defaultConfig): { name: string; configured: boolean }[] {
  return allProviders(config).map((p) => ({ name: p.name, configured: p.configured() }));
}
