// The models the agent knows. Taken from pi's generated model catalog; it is
// code bundled with the agent, so step can read it, and changing it means a
// new version of the agent.

import type { ModelRef } from './content.js';
import type { ModelInfo } from './model.js';

export const MODELS: readonly ModelInfo[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'openai',
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 272_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'openai',
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    contextWindow: 400_000,
    maxTokens: 128_000,
    images: true,
    reasoning: true,
  },
  {
    provider: 'google',
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    images: true,
    reasoning: true,
  },
  {
    provider: 'google',
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    images: true,
    reasoning: true,
  },
];

/** The catalog entry for a model, or null if the agent does not know it. */
export function findModel(ref: ModelRef): ModelInfo | null {
  return MODELS.find((model) => model.provider === ref.provider && model.id === ref.id) ?? null;
}
