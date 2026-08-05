import { describe, it, expect } from 'vitest';
import { llmProviderChain, configForProvider, llmProvider, hasLLM, isTerminalForRun, LLMError } from '../src/llm';
import { config } from '../src/config';

// Pure unit tests — no network. These pin the ordering and the isolation
// guarantee that the whole failover story rests on.

const blank = { ...config, cerebrasApiKey: '', groqApiKey: '', geminiApiKey: '', anthropicApiKey: '' };

describe('llmProviderChain', () => {
  it('is empty when no keys are set', () => {
    expect(llmProviderChain(blank)).toEqual([]);
    expect(hasLLM(blank)).toBe(false);
    expect(llmProvider(blank)).toBe('heuristic');
  });

  it('lists only providers that actually have a key', () => {
    const c = { ...blank, groqApiKey: 'g', anthropicApiKey: 'a' };
    expect(llmProviderChain(c)).toEqual(['groq', 'anthropic']);
  });

  it('orders by measured free-tier capacity, not declaration order', () => {
    const all = { ...blank, cerebrasApiKey: 'c', groqApiKey: 'g', geminiApiKey: 'gem', anthropicApiKey: 'a' };
    // groq first (most usable free tier), cerebras late because every model on
    // it returns 402 without billing, anthropic last because it is paid-only.
    expect(llmProviderChain(all)).toEqual(['groq', 'gemini', 'cerebras', 'anthropic']);
  });

  it('hasLLM counts a cerebras-only config', () => {
    // Regression: hasLLM used to omit cerebras entirely, so a user whose only
    // key was Cerebras was silently treated as having no LLM at all.
    expect(hasLLM({ ...blank, cerebrasApiKey: 'csk-x' })).toBe(true);
  });
});

describe('configForProvider', () => {
  it('leaves exactly one key set, so a call cannot leak to another provider', () => {
    const all = { ...blank, cerebrasApiKey: 'c', groqApiKey: 'g', geminiApiKey: 'gem', anthropicApiKey: 'a' };
    const only = configForProvider(all, 'gemini');
    expect(only.geminiApiKey).toBe('gem');
    expect(only.groqApiKey).toBe('');
    expect(only.cerebrasApiKey).toBe('');
    expect(only.anthropicApiKey).toBe('');
    expect(llmProvider(only)).toBe('gemini');
  });
});

describe('isTerminalForRun', () => {
  it('treats 401/402/403/429 as terminal for the provider', () => {
    for (const s of [401, 402, 403, 429]) {
      expect(isTerminalForRun(new LLMError('x', s))).toBe(true);
    }
  });

  it('does NOT treat size/server errors as terminal — those are worth retrying smaller', () => {
    for (const s of [400, 413, 500, 503]) {
      expect(isTerminalForRun(new LLMError('x', s))).toBe(false);
    }
  });

  it('402 is terminal — Cerebras returns it for every model without billing', () => {
    expect(isTerminalForRun(new LLMError('Payment required', 402))).toBe(true);
  });
});
