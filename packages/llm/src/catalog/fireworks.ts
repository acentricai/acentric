// Fireworks serverless models. Standard prices in US dollars per million
// tokens, from https://docs.fireworks.ai/serverless/pricing and the model
// pages, as of October 2026. Fireworks has no long-context prices, charges
// nothing for cache writes and documents no output limit per model. The
// "fast" routers are model IDs of their own, with their own prices.

import type { ModelPricing, ModelInfo } from '../model.js';

const VISION = ['text', 'image'] as const;
const TEXT = ['text'] as const;
const MILLION = 1_048_576;

function cost(input: number, cacheRead: number, output: number): ModelPricing {
  return { base: { input, cacheRead, output } };
}

export const FIREWORKS_MODELS = [
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/kimi-k3',
    name: 'Kimi K3',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(3, 0.3, 15),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/routers/kimi-k3-fast',
    name: 'Kimi K3 Fast',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(4.5, 0.45, 22.5),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/ember-1',
    name: 'Ember-1',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(3, 0.3, 15),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/deepseek-v4p1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(0.3, 0.006, 1.2),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/glm-5p3',
    name: 'GLM 5.3',
    contextWindow: MILLION,
    input: TEXT,
    pricing: cost(1.4, 0.26, 4.4),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/routers/glm-5p3-fast',
    name: 'GLM 5.3 Fast',
    contextWindow: MILLION,
    input: TEXT,
    pricing: cost(2.1, 0.39, 6.6),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/glm-5p3-flash',
    name: 'GLM 5.3 Flash',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(0.15, 0.03, 0.5),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/qwen3p8-max',
    name: 'Qwen 3.8 Max',
    input: VISION,
    pricing: cost(2, 0.25, 6),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/minimax-m3',
    name: 'MiniMax M3',
    contextWindow: 512_000,
    input: TEXT,
    pricing: cost(0.3, 0.06, 1.2),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/gpt-oss-120b',
    name: 'gpt-oss-120b',
    contextWindow: 131_072,
    input: TEXT,
    pricing: cost(0.15, 0.015, 0.6),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b',
    name: 'Nemotron Lightning 3.5 30B A3B',
    contextWindow: 262_144,
    input: TEXT,
    pricing: cost(0.05, 0.01, 0.2),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/nemotron-3-ultra-nvfp4',
    name: 'Nemotron 3 Ultra (Preview)',
    contextWindow: 262_144,
    input: TEXT,
    pricing: cost(0.6, 0.12, 2.4),
  },
  {
    provider: 'fireworks',
    id: 'accounts/fireworks/models/inkling',
    name: 'Inkling',
    contextWindow: MILLION,
    input: VISION,
    pricing: cost(1, 0.17, 4.05),
  },
] as const satisfies readonly ModelInfo<'fireworks'>[];
