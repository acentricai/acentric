// One call straight to a provider, with credentials in hand. What the client
// does when it has a provider's key, and what a gateway runs for each request.

import type { Json } from '@acentric/types';

import { LlmError } from '../failure.js';
import { isObject } from '../json.js';
import type { Credentials, Provider } from '../providers.js';
import type { LlmRequest } from '../request.js';
import type { LlmResponse } from '../response.js';
import { httpFailure as anthropicFailure } from './anthropic/errors.js';
import { buildRequest as anthropicRequest } from './anthropic/request.js';
import { parseResponse as anthropicResponse } from './anthropic/response.js';
import { postJson, withRequestId } from './http.js';
import type { JsonAnswer } from './http.js';
import { httpFailure as responsesFailure } from './responses/errors.js';
import type { ResponsesProfile, ResponsesProvider } from './responses/profile.js';
import { fireworksProfile, openAiProfile } from './responses/providers.js';
import { buildRequest as responsesRequest } from './responses/request.js';
import { parseResponse as responsesResponse } from './responses/response.js';
import { invalidRequest } from './util.js';

/** The only Anthropic Messages API version. */
const ANTHROPIC_VERSION = '2023-06-01';

export type CallOptions = {
  /** Stops the call; it then fails with `cancelled`. */
  readonly signal?: AbortSignal;
  /** A fetch to use instead of the global one, such as in tests. */
  readonly fetch?: typeof fetch;
};

/** One completion from the request's provider. Never retried. */
export async function callProvider<P extends Provider>(
  request: LlmRequest<P>,
  credentials: Credentials<P>,
  options: CallOptions = {},
): Promise<LlmResponse<P>> {
  // Each branch narrows the request to its provider; the result is that provider's.
  const any: LlmRequest = request;
  const name: string = request.provider;
  switch (any.provider) {
    case 'anthropic':
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return (await callAnthropic(
        any,
        readCredentials('anthropic', credentials),
        options,
      )) as LlmResponse<P>;
    case 'openai':
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return (await callResponses(
        any,
        readCredentials('openai', credentials),
        openAiProfile,
        options,
      )) as LlmResponse<P>;
    case 'fireworks':
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return (await callResponses(
        any,
        readCredentials('fireworks', credentials),
        fireworksProfile,
        options,
      )) as LlmResponse<P>;
    default:
      throw invalidRequest(undefined, `there is no provider ${name}`);
  }
}

async function callAnthropic(
  request: LlmRequest<'anthropic'>,
  credentials: Credentials<'anthropic'>,
  options: CallOptions,
): Promise<LlmResponse<'anthropic'>> {
  const { body, betas } = anthropicRequest(request);
  const answer = await postJson({
    provider: 'anthropic',
    label: 'Anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': credentials.apiKey,
      ...(credentials.workspaceId === undefined
        ? {}
        : { 'anthropic-workspace-id': credentials.workspaceId }),
      'anthropic-version': ANTHROPIC_VERSION,
      ...(betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {}),
    },
    body,
    ...common(request, options),
    failed: anthropicFailure,
  });
  return read(answer, () => anthropicResponse(request, answer));
}

async function callResponses<P extends ResponsesProvider>(
  request: LlmRequest<P>,
  credentials: Credentials<P>,
  profile: ResponsesProfile<P>,
  options: CallOptions,
): Promise<LlmResponse<P>> {
  const body = responsesRequest(request, profile);
  const answer = await postJson({
    provider: profile.provider,
    label: profile.label,
    url: profile.url,
    headers: profile.headers(credentials),
    body,
    ...common(request, options),
    failed: (http) => responsesFailure(profile, http),
  });
  return read(answer, () => responsesResponse(request, answer, profile));
}

function common(
  request: LlmRequest,
  { signal, fetch }: CallOptions,
): { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch } {
  return {
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
    ...(fetch === undefined ? {} : { fetch }),
  };
}

/** Reads an answer; a failure while reading names the provider's request ID. */
function read<T>(answer: JsonAnswer, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw error instanceof LlmError ? withRequestId(error, answer.requestId) : error;
  }
}

/**
 * Credentials checked before they are sent, since a gateway takes them from
 * its callers. A message names the field at fault, never its value.
 */
export function readCredentials<P extends Provider>(
  provider: P,
  value: Json | undefined,
): Credentials<P> {
  if (!isObject(value))
    throw invalidRequest(provider, `the ${provider} credentials must be an object with an apiKey`);
  const fields: { [name: string]: string } = {};
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== 'string' || field.trim() === '') {
      throw invalidRequest(provider, `credentials.${name} must be a string that is not empty`);
    }
    fields[name] = field.trim();
  }
  if (fields['apiKey'] === undefined)
    throw invalidRequest(provider, 'credentials.apiKey is missing');
  // Every provider's credentials are an apiKey and optional string fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fields as unknown as Credentials<P>;
}
