// The providers on the Responses format: OpenAI and Fireworks.

import type { ResponsesProfile } from './profile.js';

/** OpenAI's prices for the tier that served a response. Other tiers' are not published. */
const OPENAI_TIERS: { readonly [tier: string]: number } = { default: 1, flex: 0.5 };

export const openAiProfile: ResponsesProfile<'openai'> = {
  provider: 'openai',
  label: 'OpenAI',
  url: 'https://api.openai.com/v1/responses',
  systemRole: 'developer',
  files: true,
  fileIds: true,
  customTools: true,
  echoFields: ['prompt', 'prompt_cache_retention', 'prompt_cache_options'],
  // Written on output items and refused on input.
  outputOnlyFields: ['created_by'],

  headers({ apiKey, organization, project }) {
    return {
      authorization: `Bearer ${apiKey}`,
      ...(organization === undefined ? {} : { 'openai-organization': organization }),
      ...(project === undefined ? {} : { 'openai-project': project }),
    };
  },

  priceMultiplier(native) {
    const tier = native['service_tier'];
    return OPENAI_TIERS[typeof tier === 'string' ? tier : 'default'];
  },

  classifyError({ status, message }) {
    // Some context window errors come without the context_length_exceeded code.
    if (
      status === 400 &&
      message !== undefined &&
      /exceeds the context window|maximum context length/i.test(message)
    ) {
      return { kind: 'context_overflow' };
    }
    return undefined;
  },
};

export const fireworksProfile: ResponsesProfile<'fireworks'> = {
  provider: 'fireworks',
  label: 'Fireworks',
  url: 'https://api.fireworks.ai/inference/v1/responses',
  systemRole: 'system',
  // Fireworks drops file parts without an error, has no file storage, and
  // takes custom tools its models never call.
  files: false,
  fileIds: false,
  customTools: false,
  // Fireworks repeats the reasoning settings it was sent; they say nothing new.
  echoFields: ['reasoning'],
  outputOnlyFields: ['created_by'],

  headers({ apiKey }) {
    return { authorization: `Bearer ${apiKey}` };
  },

  // The response does not say which tier served it. Standard prices hold
  // unless the request asked for another tier, whose prices differ by model.
  priceMultiplier(_native, options) {
    const tier = options['service_tier'];
    return tier === undefined || tier === null || tier === 'default' ? 1 : undefined;
  },

  classifyError({ status, message }) {
    // A previous response that is unknown, expired or not stored: a bare 404 `{ detail }`.
    if (status === 404 && message !== undefined && /^previous response not found/i.test(message)) {
      return { kind: 'not_found', param: 'previous_response_id' };
    }
    if (
      message !== undefined &&
      /prompt is too long|exceeds maximum context length/i.test(message)
    ) {
      return { kind: 'context_overflow' };
    }
    if (status === 402) return { kind: 'quota_exceeded' };
    // A suspended account.
    if (status === 412) return { kind: 'auth' };
    return undefined;
  },
};
