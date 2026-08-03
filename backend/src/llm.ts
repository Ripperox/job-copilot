import { Config } from './config';

export type LLMProvider = 'gemini' | 'groq' | 'anthropic' | 'heuristic';

// Carries the provider's HTTP status so callers can tell "this key is wrong"
// (401/403) from "this key is fine but out of quota right now" (429).
export class LLMError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LLMError';
  }
}

export function isRateLimit(e: unknown): boolean {
  return e instanceof LLMError && e.status === 429;
}

// Groq is preferred over Gemini on measured free-tier capacity (2026-08-03):
// Groq llama-3.3-70b allows ~1000 requests/day, while Gemini's free tier is
// ~20 requests/day on gemini-3.6-flash and 0 on the older 2.0 models. Scoring a
// job pool needs hundreds of calls a day, so Groq is the only workable default.
export function llmProvider(config: Config): LLMProvider {
  if (config.groqApiKey) return 'groq';
  if (config.geminiApiKey) return 'gemini';
  if (config.anthropicApiKey) return 'anthropic';
  return 'heuristic';
}

export function hasLLM(config: Config): boolean {
  return Boolean(config.geminiApiKey || config.groqApiKey || config.anthropicApiKey);
}

// Send a single-user-message prompt to the configured LLM and return its text.
// Prefers Gemini (free, generous quota), then Groq, then Anthropic. Throws if none set.
export async function llmComplete(prompt: string, config: Config, maxTokens = 500): Promise<string> {
  if (config.groqApiKey) return groqComplete(prompt, config, maxTokens);
  if (config.geminiApiKey) return geminiComplete(prompt, config, maxTokens);
  if (config.anthropicApiKey) return anthropicComplete(prompt, config, maxTokens);
  throw new Error('No LLM configured');
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
  if (!resp.ok) throw new LLMError(`Gemini ${resp.status}: ${await resp.text()}`, resp.status);
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
  if (!resp.ok) throw new LLMError(`Groq ${resp.status}: ${await resp.text()}`, resp.status);
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
  if (!resp.ok) throw new LLMError(`Anthropic ${resp.status}: ${await resp.text()}`, resp.status);
  const data: any = await resp.json();
  return data.content?.[0]?.text ?? '';
}
