// A web-scraping provider. Several vendors do the same two jobs — search the web,
// and turn one page into clean text — so they hide behind this interface and the
// chain in ./index.ts falls through to the next one when a provider is out of
// quota, rate-limited, or down.

export interface ScrapeResult {
  url: string;
  title: string;
  /** Clean, readable page text (markdown or plain). */
  content: string;
}

export interface SearchResult {
  url: string;
  title: string;
  /** Snippet or summary — may be empty. */
  snippet: string;
}

export interface ScrapeProvider {
  readonly name: string;
  /** True when this provider has the credentials it needs. */
  configured(): boolean;
  /** Fetch one page as clean text. */
  scrape(url: string): Promise<ScrapeResult>;
  /** Web search. Optional — not every provider does search. */
  search?(query: string, limit: number): Promise<SearchResult[]>;
}

// Errors where moving to the next provider is the right move: quota gone, rate
// limited, or auth rejected. A 404 is NOT one of these — the page is simply
// missing and the next provider will also fail to find it.
export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly provider: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function shouldFailOver(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return true; // network/parse errors: try the next one
  return e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429 || e.status >= 500;
}
