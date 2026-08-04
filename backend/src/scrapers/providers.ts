import { Config } from '../config';
import { ProviderError, ScrapeProvider, ScrapeResult, SearchResult } from './types';

// Each provider is a thin adapter over one vendor's HTTP API. They deliberately
// do the minimum: search the web, and turn a page into clean text.

async function jsonOrThrow(resp: Response, provider: string): Promise<any> {
  if (!resp.ok) {
    throw new ProviderError(`${provider} ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status, provider);
  }
  return resp.json();
}

// --- Firecrawl: the primary. Best extraction quality; 1000 free credits/month.
export function firecrawlProvider(config: Config): ScrapeProvider {
  return {
    name: 'firecrawl',
    configured: () => Boolean(config.firecrawlApiKey),
    async scrape(url) {
      const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.firecrawlApiKey}` },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      });
      const data = await jsonOrThrow(resp, 'firecrawl');
      return {
        url,
        title: data?.data?.metadata?.title ?? '',
        content: data?.data?.markdown ?? '',
      } satisfies ScrapeResult;
    },
    async search(query, limit) {
      const resp = await fetch('https://api.firecrawl.dev/v2/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.firecrawlApiKey}` },
        body: JSON.stringify({ query, limit }),
      });
      const data = await jsonOrThrow(resp, 'firecrawl');
      return (data?.data?.web ?? []).map((r: any): SearchResult => ({
        url: r.url ?? '',
        title: r.title ?? '',
        snippet: r.description ?? '',
      }));
    },
  };
}

// --- Tavily: closest like-for-like fallback, built for AI agents.
export function tavilyProvider(config: Config): ScrapeProvider {
  return {
    name: 'tavily',
    configured: () => Boolean(config.tavilyApiKey),
    async scrape(url) {
      const resp = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyApiKey}` },
        body: JSON.stringify({ urls: [url] }),
      });
      const data = await jsonOrThrow(resp, 'tavily');
      const first = data?.results?.[0];
      return { url, title: first?.title ?? '', content: first?.raw_content ?? '' } satisfies ScrapeResult;
    },
    async search(query, limit) {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyApiKey}` },
        body: JSON.stringify({ query, max_results: limit }),
      });
      const data = await jsonOrThrow(resp, 'tavily');
      return (data?.results ?? []).map((r: any): SearchResult => ({
        url: r.url ?? '',
        title: r.title ?? '',
        snippet: r.content ?? '',
      }));
    },
  };
}

// --- Exa: semantic search rather than keyword; good at "find pages like this".
export function exaProvider(config: Config): ScrapeProvider {
  return {
    name: 'exa',
    configured: () => Boolean(config.exaApiKey),
    async scrape(url) {
      const resp = await fetch('https://api.exa.ai/contents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.exaApiKey },
        body: JSON.stringify({ urls: [url], text: true }),
      });
      const data = await jsonOrThrow(resp, 'exa');
      const first = data?.results?.[0];
      return { url, title: first?.title ?? '', content: first?.text ?? '' } satisfies ScrapeResult;
    },
    async search(query, limit) {
      const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.exaApiKey },
        body: JSON.stringify({ query, numResults: limit, contents: { text: true } }),
      });
      const data = await jsonOrThrow(resp, 'exa');
      return (data?.results ?? []).map((r: any): SearchResult => ({
        url: r.url ?? '',
        title: r.title ?? '',
        snippet: (r.text ?? '').slice(0, 500),
      }));
    },
  };
}

// --- Jina Reader: last-resort page reader. Works with no key at all (tighter
// rate limits), which makes it a genuine safety net when every paid tier is out.
export function jinaProvider(config: Config): ScrapeProvider {
  return {
    name: 'jina',
    configured: () => true, // usable keyless
    async scrape(url) {
      const headers: Record<string, string> = { accept: 'text/plain' };
      if (config.jinaApiKey) headers.authorization = `Bearer ${config.jinaApiKey}`;
      const resp = await fetch(`https://r.jina.ai/${url}`, { headers });
      if (!resp.ok) {
        throw new ProviderError(`jina ${resp.status}`, resp.status, 'jina');
      }
      const text = await resp.text();
      return { url, title: text.split('\n').find((l) => l.startsWith('Title:'))?.slice(6).trim() ?? '', content: text };
    },
    // No search — Jina is a reader only.
  };
}

export function allProviders(config: Config): ScrapeProvider[] {
  return [
    firecrawlProvider(config),
    tavilyProvider(config),
    exaProvider(config),
    jinaProvider(config),
  ];
}
