import { Config } from './config';
import * as usage from './usage';

export type LLMProvider = 'nemotron' | 'cerebras' | 'gemini' | 'groq' | 'anthropic' | 'heuristic';

// Carries the provider's HTTP status so callers can tell "this key is wrong"
// (401/403) from "this key is fine but out of quota right now" (429).
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * How long the provider says to wait, in ms, when it tells us.
     *
     * This matters because a 429 is two different situations wearing the same
     * status code. Groq's per-minute token bucket refills in ~15s — waiting is
     * exactly right and abandoning the provider throws away a working key. Its
     * daily budget resets in hours — waiting is pointless and moving to the
     * next provider is right. Only retry-after can tell them apart.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Parse Retry-After (seconds, or an HTTP date) into ms. */
export function retryAfterMs(resp: Response): number | undefined {
  const raw = resp.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/** A pause we are willing to sit through mid-run rather than switch provider. */
export const MAX_WAIT_MS = 45_000;

export function isRateLimit(e: unknown): boolean {
  return e instanceof LLMError && e.status === 429;
}

// Errors where retrying — with a smaller batch or anything else — cannot help
// for the remainder of this run: the key is wrong (401/403), the account cannot
// pay for the model (402), or the quota is gone (429). Callers should stop
// calling THIS provider and move to the next one rather than fan out.
// Gemini answers an invalid key with HTTP 400 INVALID_ARGUMENT / API_KEY_INVALID
// rather than 401 (verified 2026-08-05). Status alone therefore misses it, the
// caller mistakes it for "batch too big", splits, and fans out to one doomed
// request per job. Match the message as well.
const AUTH_MESSAGE =
  /api[ _]?key not valid|api_key_invalid|invalid api[ _]?key|unauthorized|permission denied|payment required|billing/i;

// A missing or inaccessible MODEL is terminal for that provider too. Cerebras
// answers a bad model name with 404 "Model does not exist or you do not have
// access to it" (observed 2026-08-05), and 404 is not otherwise terminal — so
// the caller kept retrying page by page, ten doomed requests for four pages.
const MODEL_MESSAGE = /model does not exist|model_not_found|no such model|unknown model|does not exist or you do not have access/i;

export function isTerminalForRun(e: unknown): boolean {
  if (!(e instanceof LLMError)) return false;
  if (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429) return true;
  if (e.status === 400 && AUTH_MESSAGE.test(e.message)) return true;
  return e.status === 404 && MODEL_MESSAGE.test(e.message);
}

// Why a provider was retired, for the run log.
export function terminalReason(e: unknown): string {
  if (!(e instanceof LLMError)) return 'failed';
  if (e.status === 429) return 'rate limited';
  if (e.status === 402) return 'payment required';
  return 'key rejected';
}

// Preference order is set by measured free-tier capacity, because this workload
// (extracting career pages + scoring a few hundred jobs daily) is large enough
// that the free ceiling is the binding constraint. Measured 2026-08-04:
//
//   nemotron    NVIDIA free tier — generous, OpenAI-compatible, reasoning support
//   groq        ~100,000 tokens/day, 1,000 req/day   <- most usable free tier
//   gemini            ~20 requests/day on 3.6-flash  (exhausts almost at once)
//   cerebras    key authenticates, but every model in the catalog returns
//               402 Payment Required — there is no usable free tier, so it
//               ranks last despite the headline quota. Kept because it is
//               excellent once billing is on, and BYOK users may have paid.
//   anthropic   paid only
//
// Cerebras caps context near 8k tokens, so batch sizes are smaller for it —
// see PAGES_PER_REQUEST and BATCH_SIZE.
const PREFERENCE: Exclude<LLMProvider, 'heuristic'>[] = [
  'nemotron',
  'groq',
  'gemini',
  'cerebras',
  'anthropic',
];

export function keyFor(config: Config, provider: LLMProvider): string {
  if (provider === 'nemotron') return config.nemotronApiKey;
  if (provider === 'cerebras') return config.cerebrasApiKey;
  if (provider === 'groq') return config.groqApiKey;
  if (provider === 'gemini') return config.geminiApiKey;
  if (provider === 'anthropic') return config.anthropicApiKey;
  return '';
}

/**
 * Every provider this config can actually reach, best first.
 *
 * Free tiers die without warning — a quota resets to zero, a model moves behind
 * billing (Cerebras did exactly that). One dead provider must not sink a run
 * when working keys are sitting right there, so callers walk this list.
 */
export function llmProviderChain(config: Config): Exclude<LLMProvider, 'heuristic'>[] {
  return PREFERENCE.filter((p) => Boolean(keyFor(config, p)));
}

/** Narrows a config to exactly one provider, so no call can silently use another. */
export function configForProvider(base: Config, provider: LLMProvider): Config {
  return {
    ...base,
    nemotronApiKey: provider === 'nemotron' ? base.nemotronApiKey : '',
    cerebrasApiKey: provider === 'cerebras' ? base.cerebrasApiKey : '',
    groqApiKey: provider === 'groq' ? base.groqApiKey : '',
    geminiApiKey: provider === 'gemini' ? base.geminiApiKey : '',
    anthropicApiKey: provider === 'anthropic' ? base.anthropicApiKey : '',
  };
}

export function llmProvider(config: Config): LLMProvider {
  return llmProviderChain(config)[0] ?? 'heuristic';
}

export function hasLLM(config: Config): boolean {
  return llmProviderChain(config).length > 0;
}

// Send a single-user-message prompt to the configured LLM and return its text.
// Uses the highest-preference provider this config has a key for; callers that
// want failover walk llmProviderChain() and narrow with configForProvider().
export async function llmComplete(prompt: string, config: Config, maxTokens = 500): Promise<string> {
  const provider = llmProvider(config);
  if (provider === 'heuristic') throw new Error('No LLM configured');

  // Counted here because this is the one place every model request passes
  // through, and counted BEFORE the call: a request that comes back 429 or 500
  // has still been spent as far as most providers' daily counters go.
  void usage.bump(provider);

  switch (provider) {
    case 'nemotron':
      return nemotronComplete(prompt, config, maxTokens);
    case 'groq':
      return groqComplete(prompt, config, maxTokens);
    case 'gemini':
      return geminiComplete(prompt, config, maxTokens);
    case 'cerebras':
      return cerebrasComplete(prompt, config, maxTokens);
    case 'anthropic':
      return anthropicComplete(prompt, config, maxTokens);
  }
}

// Cerebras is OpenAI-compatible, so this mirrors the Groq adapter.
async function cerebrasComplete(prompt: string, config: Config, maxTokens: number): Promise<string> {
  const resp = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.cerebrasApiKey}`,
    },
    body: JSON.stringify({
      model: config.cerebrasModel,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new LLMError(`Cerebras ${resp.status}: ${await resp.text()}`, resp.status, retryAfterMs(resp));
  const data: any = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function geminiComplete(prompt: string, config: Config, maxTokens: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        // gemini-*-latest is a thinking model whose thoughts share the output-token
        // budget (and it rejects thinkingBudget:0), so give generous headroom or the
        // thoughts starve the actual answer and it comes back empty.
        maxOutputTokens: Math.max(maxTokens, 2048),
      },
    }),
  });
  if (!resp.ok) throw new LLMError(`Gemini ${resp.status}: ${await resp.text()}`, resp.status, retryAfterMs(resp));
  const data: any = await resp.json();
  // A response can hold several parts (e.g. a thought part + the text part); join
  // every part that carries text so we never drop the answer.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => p?.text ?? '').join('');
}

async function groqComplete(prompt: string, config: Config, maxTokens: number): Promise<string> {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.groqApiKey}`,
    },
    body: JSON.stringify({
      model: config.groqModel,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new LLMError(`Groq ${resp.status}: ${await resp.text()}`, resp.status, retryAfterMs(resp));
  const data: any = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function anthropicComplete(prompt: string, config: Config, maxTokens: number): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new LLMError(`Anthropic ${resp.status}: ${await resp.text()}`, resp.status, retryAfterMs(resp));
  const data: any = await resp.json();
  return data.content?.[0]?.text ?? '';
}

// Nemotron 3 Ultra on NVIDIA's OpenAI-compatible endpoint.
// Supports reasoning (thinking) mode — we stream and concatenate both
// reasoning_content and content deltas so nothing is lost.
async function nemotronComplete(prompt: string, config: Config, maxTokens: number): Promise<string> {
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.nemotronApiKey}`,
    },
    body: JSON.stringify({
      model: config.nemotronModel,
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: Math.min(maxTokens, 16384),
      messages: [{ role: 'user', content: prompt }],
      extra_body: { chat_template_kwargs: { enable_thinking: true } },
      stream: true,
    }),
  });
  if (!resp.ok) throw new LLMError(`Nemotron ${resp.status}: ${await resp.text()}`, resp.status, retryAfterMs(resp));

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('Nemotron: no response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
        if (delta.content) fullContent += delta.content;
      } catch {
        // ignore parse errors on partial chunks
      }
    }
  }

  // Prepend reasoning if present (helps with debugging & transparency)
  return fullReasoning ? `<thinking>\n${fullReasoning}\n</thinking>\n\n${fullContent}` : fullContent;
}
