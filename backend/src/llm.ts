import { Config } from './config';

export type LLMProvider = 'groq' | 'anthropic' | 'heuristic';

export function llmProvider(config: Config): LLMProvider {
  if (config.groqApiKey) return 'groq';
  if (config.anthropicApiKey) return 'anthropic';
  return 'heuristic';
}

export function hasLLM(config: Config): boolean {
  return Boolean(config.groqApiKey || config.anthropicApiKey);
}

// Send a single-user-message prompt to the configured LLM and return its text.
// Prefers Groq (free/fast), falls back to Anthropic. Throws if neither is set.
export async function llmComplete(prompt: string, config: Config, maxTokens = 500): Promise<string> {
  if (config.groqApiKey) return groqComplete(prompt, config, maxTokens);
  if (config.anthropicApiKey) return anthropicComplete(prompt, config, maxTokens);
  throw new Error('No LLM configured');
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
  if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);
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
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data: any = await resp.json();
  return data.content?.[0]?.text ?? '';
}
