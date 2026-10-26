// Claude 5 models. Standard prices in US dollars per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing and the model pages,
// as of October 2026. A cache write costs 1.25 times the input price for five
// minutes and twice for an hour; reads are priced per model. Only Haiku 5.5
// has a long-context price: for the whole request, output included, once the
// prompt is over 100,000 tokens.

import type { ModelCost, ModelInfo } from '../model.js';

const LIMITS = { contextWindow: 1_000_000, maxOutputTokens: 128_000 } as const;
const INPUT = ['text', 'image', 'file'] as const;

function cost(
  input: number,
  output: number,
  cacheWrite: number,
  cacheWrite1h: number,
  cacheRead: number,
): ModelCost {
  return { input, output, cacheWrite, cacheWrite1h, cacheRead };
}

export const ANTHROPIC_MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(10, 50, 12.5, 20, 0.25) },
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(4, 20, 5, 8, 0.2) },
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(2, 10, 2.5, 4, 0.1) },
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    ...LIMITS,
    input: INPUT,
    pricing: {
      base: cost(0.1, 0.5, 0.125, 0.2, 0.01),
      tiers: [{ aboveInputTokens: 100_000, cost: cost(0.5, 2.5, 0.625, 1, 0.05) }],
    },
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(10, 50, 12.5, 20, 1) },
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(5, 25, 6.25, 10, 0.5) },
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    ...LIMITS,
    input: INPUT,
    pricing: { base: cost(2, 10, 2.5, 4, 0.2) },
  },
] as const satisfies readonly ModelInfo<'anthropic'>[];
