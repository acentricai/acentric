// Anthropic, on an API key.

import type { ModelCost, ModelInfo } from '../catalog.ts';
import { httpFailure } from '../anthropic/errors.ts';
import { outputText, reasoningSummary, toolCalls } from '../anthropic/read.ts';
import { LABEL, PROVIDER, buildBody } from '../anthropic/request.ts';
import { readAnswer } from '../anthropic/response.ts';
import { assemble } from '../anthropic/stream.ts';
import { post } from '../http.ts';
import { onlyOptions, readWebSearch } from '../provider.ts';
import type { Provider } from '../provider.ts';

const URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// Standard prices in US dollars for a million tokens, from Anthropic's pricing and model
// pages, as of November 2026. Writing to the cache costs 1.25 times the input price for five
// minutes and twice for an hour. Only Haiku has a long-context price: for the whole request
// once the prompt is over 100,000 tokens.
function cost(
  input: number,
  output: number,
  cacheWrite: number,
  cacheWrite1h: number,
  cacheRead: number,
): ModelCost {
  return { input, output, cacheWrite, cacheWrite1h, cacheRead };
}

const LIMITS = {
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  input: ['text', 'image', 'file'],
} as const;

export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-fable-5-2',
    name: 'Claude Fable 5.2',
    ...LIMITS,
    pricing: { base: cost(8, 40, 10, 16, 0.2) },
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    ...LIMITS,
    pricing: { base: cost(4, 20, 5, 8, 0.2) },
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    ...LIMITS,
    pricing: { base: cost(2, 10, 2.5, 4, 0.1) },
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    ...LIMITS,
    pricing: {
      base: cost(0.1, 0.5, 0.125, 0.2, 0.01),
      tiers: [{ aboveInputTokens: 100_000, cost: cost(0.5, 2.5, 0.625, 1, 0.05) }],
    },
  },
];

export const anthropic: Provider = {
  id: PROVIDER,
  label: LABEL,
  credentials: ['api_key'],
  models: ANTHROPIC_MODELS,
  defaultModel: 'claude-opus-5-5',

  parseOptions(given) {
    const asked = onlyOptions(given, ['webSearch'], LABEL);
    const search = readWebSearch(asked['webSearch'], LABEL);
    return search === undefined ? {} : { webSearch: search as never };
  },

  runner(settings) {
    const { credential } = settings;
    if (credential.type !== 'api_key') throw new TypeError('Anthropic is called with an API key');
    return {
      async run(step, signal) {
        const answer = await post({
          label: LABEL,
          provider: PROVIDER,
          url: URL,
          headers: { 'x-api-key': credential.apiKey, 'anthropic-version': VERSION },
          body: buildBody(step, ANTHROPIC_MODELS),
          signal,
          streamed: true,
          ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
        });
        if (answer.status < 200 || answer.status >= 300) throw httpFailure(answer);
        return readAnswer(step, assemble(answer.text), ANTHROPIC_MODELS);
      },
    };
  },

  read: (message) => ({
    text: outputText(message.content),
    reasoning: reasoningSummary(message.content),
    toolCalls: toolCalls(message.content),
  }),
};
