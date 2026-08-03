import { Config, config as defaultConfig } from './config';
import { db } from './db';
import { decryptSecret } from './crypto';

// Resolves the LLM config to use for one user's scoring run.
//
// The product rule: a user's own key pays for their own scoring. Operator keys
// are reserved for the cached one-job demo, so cost never scales with signups.
// A user with no key gets heuristic scoring, not the operator's quota.

export type KeyProvider = 'groq' | 'gemini' | 'anthropic';

export interface UserLLM {
  config: Config;
  hasKey: boolean;
  provider?: KeyProvider;
}

// Providers use distinctive key prefixes, so the user can paste a key from any
// of them without having to say which it is.
export function detectProvider(key: string): KeyProvider {
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  return 'gemini'; // Google keys look like "AI…" or "AQ.…"
}

// Builds a config that can reach exactly ONE provider — the user's — so a
// missing or broken user key can never silently spend the operator's quota.
export function configForKey(base: Config, provider: KeyProvider, key: string): Config {
  const blank = withoutLLM(base);
  if (provider === 'groq') return { ...blank, groqApiKey: key };
  if (provider === 'anthropic') return { ...blank, anthropicApiKey: key };
  return { ...blank, geminiApiKey: key };
}

export async function llmConfigForUser(
  userId: string,
  base: Config = defaultConfig,
): Promise<UserLLM> {
  const record = await db.getUserKeyRecord(userId);
  if (!record) return { config: withoutLLM(base), hasKey: false };

  const key = decryptSecret(record.encrypted, base.keyEncryptionSecret);
  if (!key) {
    // Stored under a different KEY_ENCRYPTION_SECRET, or corrupt.
    console.error(`could not decrypt stored key for user ${userId.slice(0, 8)}`);
    return { config: withoutLLM(base), hasKey: false };
  }

  const provider = record.provider ?? detectProvider(key);
  return { config: configForKey(base, provider, key), hasKey: true, provider };
}

// Strips every provider key so scoring degrades to the keyword heuristic.
function withoutLLM(base: Config): Config {
  return { ...base, geminiApiKey: '', groqApiKey: '', anthropicApiKey: '' };
}
