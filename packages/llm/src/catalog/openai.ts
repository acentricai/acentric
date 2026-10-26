// OpenAI models. Standard prices in US dollars per million tokens, and limits,
// from https://developers.openai.com/api/docs/pricing and the model pages, as
// of October 2026. Long-context prices are for the whole request once the
// prompt is over 272,000 tokens.

import type { ModelCost, ModelInfo, ModelPricing } from '../model.js';

function longContext(base: ModelCost, cost: ModelCost): ModelPricing {
  return { base, tiers: [{ aboveInputTokens: 272_000, cost }] };
}

const GPT_6_LIMITS = { contextWindow: 1_050_000, maxOutputTokens: 128_000 } as const;
const VISION = ['text', 'image'] as const;

export const OPENAI_MODELS = [
  {
    provider: 'openai',
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
      { input: 20, cacheRead: 2, output: 75 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
      { input: 4, cacheRead: 0.2, output: 15 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
      { input: 4, cacheRead: 0.4, output: 15 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
      { input: 0.2, cacheRead: 0.02, output: 0.75 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
      { input: 8, cacheRead: 0.8, output: 30 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
      { input: 4, cacheRead: 0.4, output: 18 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
      { input: 0.4, cacheRead: 0.04, output: 1.8 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 5, cacheRead: 0.5, output: 30 },
      { input: 10, cacheRead: 1, output: 45 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    ...GPT_6_LIMITS,
    input: VISION,
    pricing: longContext(
      { input: 2.5, cacheRead: 0.25, output: 15 },
      { input: 5, cacheRead: 0.5, output: 22.5 },
    ),
  },
  {
    provider: 'openai',
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    input: VISION,
    pricing: { base: { input: 0.75, cacheRead: 0.075, output: 4.5 } },
  },
  {
    provider: 'openai',
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    input: VISION,
    pricing: { base: { input: 2, cacheRead: 0.5, output: 8 } },
  },
] as const satisfies readonly ModelInfo<'openai'>[];
