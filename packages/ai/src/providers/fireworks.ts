// Fireworks: models of several makers, served in the Responses format.

import type { ModelInfo, ModelPricing } from '../catalog.ts';
import { effortOf, onlyOptions } from '../provider.ts';
import type { Provider } from '../provider.ts';
import type { ResponsesProfile } from '../responses/profile.ts';
import { responsesProvider } from '../responses/provider.ts';

// Standard prices in US dollars for a million tokens, from Fireworks' pricing and model
// pages, as of November 2026. It has no long-context prices, charges nothing for writing to
// its cache, and gives no limit on an answer by model.
function cost(input: number, cacheRead: number, output: number): ModelPricing {
  return { base: { input, cacheRead, output } };
}

const WINDOW = 1_048_576;

export const FIREWORKS_MODELS: readonly ModelInfo[] = [
  {
    id: 'accounts/fireworks/models/kimi-k3p1-pro',
    name: 'Kimi K3.1 Pro',
    contextWindow: WINDOW,
    input: ['text', 'image'],
    pricing: cost(2, 0.2, 10),
  },
  {
    id: 'accounts/fireworks/models/deepseek-v4p1-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    contextWindow: WINDOW,
    input: ['text', 'image'],
    pricing: cost(0.3, 0.006, 1.2),
  },
  {
    id: 'accounts/fireworks/models/glm-5p3-flash',
    name: 'GLM 5.3 Flash',
    contextWindow: WINDOW,
    input: ['text', 'image'],
    pricing: cost(0.15, 0.03, 0.5),
  },
  {
    id: 'accounts/fireworks/models/glm-5p3',
    name: 'GLM 5.3',
    contextWindow: WINDOW,
    input: ['text'],
    pricing: cost(1.4, 0.26, 4.4),
  },
];

type Levels = { readonly [level: string]: string };

/**
 * A model with three tiers, low, high and max: the levels between them are sent as the tier
 * above. It is Fireworks' own rule for Kimi, and is taken to hold for the models it says
 * nothing of.
 */
const THREE_TIERS: Levels = { low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' };

/** Models whose levels are their own. */
const LEVELS: { readonly [model: string]: Levels } = {
  // Everything between low and max is its high.
  'accounts/fireworks/models/deepseek-v4p1-flash-1017': {
    low: 'low',
    medium: 'high',
    high: 'high',
    xhigh: 'high',
    max: 'max',
  },
};

export const fireworksProfile: ResponsesProfile = {
  id: 'fireworks',
  label: 'Fireworks',
  url: 'https://api.fireworks.ai/inference/v1/responses',
  models: FIREWORKS_MODELS,
  systemRole: 'system',
  // It drops a file without an error, and has no storage to name one in.
  files: false,
  fileIds: false,
  outputOnlyFields: ['created_by'],
  instructionsInInput: false,
  streams: false,
  headers(credential) {
    if (credential.type !== 'api_key') throw new TypeError('Fireworks is called with an API key');
    return { authorization: `Bearer ${credential.apiKey}` };
  },
  options(step) {
    return {
      reasoning: { effort: effortOf(LEVELS[step.model] ?? THREE_TIERS, step.reasoning) },
      ...(step.session === undefined ? {} : { prompt_cache_key: step.session }),
    };
  },
  hostedTools: () => [],
  // The response does not say which tier served it, and a call here asks for no other.
  priceMultiplier: () => 1,
  classify({ status, message }) {
    if (
      message !== undefined &&
      /prompt is too long|exceeds maximum context length/i.test(message)
    ) {
      return { kind: 'context_overflow' };
    }
    if (status === 402) return { kind: 'quota_exceeded' };
    // An account that was suspended.
    if (status === 412) return { kind: 'auth' };
    return undefined;
  },
};

export const fireworks: Provider = responsesProvider(fireworksProfile, {
  credentials: ['api_key'],
  defaultModel: 'accounts/fireworks/models/kimi-k3p1-pro',
  parseOptions: (given) => {
    onlyOptions(given, [], 'Fireworks');
    return {};
  },
});
