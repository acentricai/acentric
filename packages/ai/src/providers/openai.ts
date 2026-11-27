// OpenAI, on an API key, and ChatGPT, on the plan of someone signed in with ChatGPT. The two
// are OpenAI's models at the same address, in the same format: they differ in what signs a
// call, in what pays for it, and in that ChatGPT answers only as a stream and keeps nothing.
//
// What a ChatGPT plan's calls may not have, as OpenAI's "Preview limitations" for Sign in with
// ChatGPT lists it, none of these requests has: no `max_output_tokens`, `metadata`,
// `temperature`, `truncation`, `prompt_cache_retention`, `previous_response_id` or system
// messages, and no files by ID. Seen on a real plan (2026-11-27): it refuses `store: true` and
// the `compaction_trigger` and `configuration_update` items, takes `context_management`, and
// keeps its cache only for calls with a `session-id` header.

import type { JsonObject, ProviderFields } from '@acentric/protocol';

import type { ModelCost, ModelInfo, ModelPricing } from '../catalog.ts';
import type { FailureKind } from '../failure.ts';
import { effortOf, onlyOptions, readWebSearch } from '../provider.ts';
import type { Credential, Provider, WebSearch } from '../provider.ts';
import type { ErrorInput, ErrorReading, ResponsesProfile } from '../responses/profile.ts';
import { responsesProvider } from '../responses/provider.ts';
import type { ModelStep } from '../runner.ts';
import { chatGptSignIn } from './chatgpt-sign-in.ts';

// Standard prices in US dollars for a million tokens, and limits, from OpenAI's pricing and
// model pages, as of November 2026. The long-context prices are for the whole request once the
// prompt is over 272,000 tokens. A cache write is priced for 30 minutes.
function longContext(base: ModelCost, cost: ModelCost): ModelPricing {
  return { base, tiers: [{ aboveInputTokens: 272_000, cost }] };
}

const LIMITS = {
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  input: ['text', 'image'],
} as const;

// From GPT-6.2 a model's reasoning is tied to what came before it: OpenAI throws away, without
// an error, the reasoning from before a change (its "Keep the prefix unchanged", November 2026).
export const OPENAI_MODELS: readonly ModelInfo[] = [
  {
    id: 'gpt-6.2-astra',
    name: 'GPT-6.2 Astra',
    ...LIMITS,
    bindsReasoning: true,
    pricing: longContext(
      { input: 8, cacheRead: 0.4, cacheWrite: 10, output: 40 },
      { input: 16, cacheRead: 0.8, cacheWrite: 20, output: 60 },
    ),
  },
  {
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    ...LIMITS,
    bindsReasoning: true,
    pricing: longContext(
      { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
      { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 },
    ),
  },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    ...LIMITS,
    bindsReasoning: false,
    pricing: longContext(
      { input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5 },
      { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 7.5 },
    ),
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    ...LIMITS,
    bindsReasoning: false,
    pricing: longContext(
      { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
      { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 0.75 },
    ),
  },
];

/** Every level is sent as itself. */
const LEVELS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** OpenAI's prices for the tier that served a response. Other tiers' are not published. */
const TIERS: { readonly [tier: string]: number } = { default: 1, flex: 0.5 };

function options(step: ModelStep): JsonObject {
  return {
    // The reasoning of earlier turns is reasoned from too: every model's own way so far, said
    // so that it stays so. What a model gives of its reasoning is given in words.
    reasoning: { effort: effortOf(LEVELS, step.reasoning), summary: 'auto', context: 'all_turns' },
    // Nothing is kept at OpenAI, so the reasoning comes back sealed, to be sent again.
    store: false,
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: true,
    ...(step.session === undefined ? {} : { prompt_cache_key: step.session }),
  };
}

function hostedTools(asked: ProviderFields): JsonObject[] {
  const search = asked['webSearch'] as WebSearch | undefined;
  if (search === undefined) return [];
  // It reaches the web as it is now, not only what was kept of it.
  const filters =
    search === true
      ? {}
      : 'allowedDomains' in search
        ? { filters: { allowed_domains: [...search.allowedDomains] } }
        : { filters: { blocked_domains: [...search.blockedDomains] } };
  return [{ type: 'web_search', external_web_access: true, ...filters }];
}

function parseOptions(label: string): (given: unknown) => ProviderFields {
  return (given) => {
    const asked = onlyOptions(given, ['webSearch'], label);
    const search = readWebSearch(asked['webSearch'], label);
    return search === undefined ? {} : { webSearch: search as ProviderFields[string] };
  };
}

/** Some failures for a conversation too long come without the code that says so. */
function tooLong({ status, message }: ErrorInput): ErrorReading | undefined {
  const said =
    message !== undefined && /exceeds the context window|maximum context length/i.test(message);
  return status === 400 && said ? { kind: 'context_overflow' } : undefined;
}

const SHARED = {
  url: 'https://api.openai.com/v1/responses',
  models: OPENAI_MODELS,
  systemRole: 'developer',
  files: true,
  fileIds: true,
  // Written on output items, and refused when they are sent back.
  outputOnlyFields: ['created_by'],
  // From GPT-6.2 the `instructions` field goes after the input, where nothing is kept of it.
  instructionsInInput: true,
  options,
  hostedTools,
  searchPrice: 0.01,
} as const;

export const openAiProfile: ResponsesProfile = {
  ...SHARED,
  id: 'openai',
  label: 'OpenAI',
  modelsUrl: 'https://api.openai.com/v1/models',
  streams: false,
  compacts: 'trigger',
  reasoningChange: (_model: string, reasoning: string) => ({
    type: 'configuration_update',
    reasoning: { effort: effortOf(LEVELS, reasoning) },
  }),
  headers(credential: Credential) {
    if (credential.type !== 'api_key') throw new TypeError('OpenAI is called with an API key');
    return { authorization: `Bearer ${credential.apiKey}` };
  },
  priceMultiplier(response) {
    const tier = response['service_tier'];
    return TIERS[typeof tier === 'string' ? tier : 'default'];
  },
  classify: tooLong,
};

export const openai: Provider = responsesProvider(openAiProfile, {
  credentials: ['api_key'],
  defaultModel: 'gpt-6.2-sol',
  // A model that is not known here is a newer one, and the newer ones all do.
  bindsReasoning: true,
  parseOptions: parseOptions('OpenAI'),
});

/**
 * OpenAI's models on a ChatGPT plan. The token is that of someone who signed in with ChatGPT
 * and let this application use their plan: it is OpenAI's own way for an application to do so.
 * The calls are to OpenAI's API, and count against the plan's limits.
 */
export const chatGptProfile: ResponsesProfile = {
  ...SHARED,
  id: 'chatgpt',
  label: 'ChatGPT',
  // A plan's calls answer only as a stream, and nothing of them is kept.
  streams: true,
  // A plan's calls take neither a `compaction_trigger` item nor a `configuration_update`: its
  // conversations are compacted on the server, and a new reasoning level is the request's.
  compacts: 'threshold',
  // As Codex and pi send it: without it, a plan keeps nothing of a conversation for its next
  // call, whatever its `prompt_cache_key` (seen 2026-11-27). OpenAI's API on a key does.
  sessionHeader: 'session-id',
  // There is no storage of the plan's to name a file in.
  fileIds: false,
  headers(credential: Credential) {
    if (credential.type !== 'access_token') {
      throw new TypeError('ChatGPT is called with the token of someone signed in with ChatGPT');
    }
    return { authorization: `Bearer ${credential.accessToken}`, accept: 'text/event-stream' };
  },
  // The plan pays, not by the token: what is noted is what the same call costs at the API's
  // standard prices.
  plan: true,
  priceMultiplier: () => 1,
  classify(failure) {
    const code = failure.code ?? failure.type;
    const reading = code === undefined ? undefined : PLAN_FAILURES[code];
    if (reading !== undefined) {
      const said = failure.message === undefined ? '' : `: ${failure.message}`;
      return { kind: reading.kind, message: reading.message ?? `ChatGPT refused the call${said}` };
    }
    return tooLong(failure);
  },
};

/** Where a person sees and changes what the plan lets each application use. */
const USAGE_PAGE = 'https://chatgpt.com/settings/usage';

/**
 * What the plan's own failures mean, as OpenAI's Sign in with ChatGPT documents them. A
 * message that is left out is the provider's own.
 */
const PLAN_FAILURES: {
  readonly [code: string]: { readonly kind: FailureKind; readonly message?: string };
} = {
  // The plan's limit, or the one the person set for this application. When it resets is not
  // said, and is not to be guessed.
  subscription_sharing_usage_limit_exceeded: {
    kind: 'quota_exceeded',
    message: `The ChatGPT plan's limit for Acentric is reached: see ${USAGE_PAGE}`,
  },
  subscription_sharing_user_not_eligible: {
    kind: 'quota_exceeded',
    message: 'This ChatGPT account or workspace may not use its plan in Acentric',
  },
  // For a while only: the same call is made again later.
  subscription_sharing_usage_unavailable: { kind: 'overloaded' },
  subscription_sharing_user_unavailable: { kind: 'overloaded' },
  subscription_sharing_unsupported_capability: { kind: 'invalid_request' },
  subscription_sharing_route_not_supported: { kind: 'invalid_request' },
  subscription_sharing_invalid_user: { kind: 'auth' },
  chatpass_v2_scope_not_authorized: { kind: 'auth' },
  chatpass_v2_invalid_authorization_context: { kind: 'auth' },
};

export const chatgpt: Provider = responsesProvider(chatGptProfile, {
  credentials: ['access_token'],
  defaultModel: 'gpt-6.2-sol',
  bindsReasoning: true,
  parseOptions: parseOptions('ChatGPT'),
  signIn: chatGptSignIn,
});
