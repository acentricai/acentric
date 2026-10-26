// A Responses answer read into an LlmResponse.

import type { Json, JsonObject } from '@acentric/types';

import { estimateCost } from '../../cost.js';
import { LlmError } from '../../failure.js';
import { isArray, isObject } from '../../json.js';
import { findModel } from '../../models.js';
import { pendingToolCalls } from '../../read/responses.js';
import type { LlmRequest } from '../../request.js';
import type { LlmResponse, StopReason } from '../../response.js';
import type { Usage } from '../../usage.js';
import type { JsonAnswer } from '../http.js';
import { invalidResponse, omit, tokens, show } from '../util.js';
import { failedResponse } from './errors.js';
import type { ResponsesProfile, ResponsesProvider } from './profile.js';

/** Response fields every Responses provider repeats from the request, or that the response already holds. */
const ECHO_FIELDS = [
  'id',
  'object',
  'model',
  'output',
  'output_text',
  'usage',
  'error',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'max_output_tokens',
  'max_tool_calls',
  'temperature',
  'top_p',
  'top_logprobs',
  'frequency_penalty',
  'presence_penalty',
  'text',
  'truncation',
  'store',
  'background',
  'previous_response_id',
  'conversation',
  'prompt_cache_key',
  'safety_identifier',
  'user',
  'metadata',
  'include',
];

/** Usage fields `readUsage` maps; anything else in `usage` stays in `native.usage`. */
const TOKEN_FIELDS: { readonly [field: string]: readonly string[] | true } = {
  input_tokens: true,
  output_tokens: true,
  total_tokens: true,
  input_tokens_details: ['cached_tokens', 'cache_write_tokens'],
  output_tokens_details: ['reasoning_tokens'],
};

export function parseResponse<P extends ResponsesProvider>(
  request: LlmRequest<P>,
  answer: JsonAnswer,
  profile: ResponsesProfile<P>,
): LlmResponse<P> {
  const { provider, label } = profile;
  const body = answer.body;
  if (!isObject(body))
    throw invalidResponse(provider, `${label} did not answer with a response`, body);
  const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : undefined;
  const rawUsage = body['usage'];
  const usage = isObject(rawUsage) ? readUsage(rawUsage) : undefined;

  // A failure can come with HTTP 200, as a failed response or a bare error.
  const error = body['error'];
  if (body['status'] === 'failed' || (error !== null && error !== undefined)) {
    throw failedResponse(profile, error ?? null, id, usage);
  }
  const output = body['output'];
  const status = body['status'];
  if (body['object'] !== 'response' || !isArray(output)) {
    throw invalidResponse(provider, `${label} did not answer with a response`, body);
  }
  if (status === 'cancelled') {
    throw new LlmError(`${label} cancelled the response`, {
      kind: 'cancelled',
      provider,
      ...(id === undefined ? {} : { responseId: id }),
    });
  }
  if (status !== 'completed' && status !== 'incomplete') {
    throw invalidResponse(
      provider,
      `${label} answered with a ${show(status)} response, not a finished one`,
      body,
    );
  }

  const details = body['incomplete_details'];
  const incomplete =
    isObject(details) && typeof details['reason'] === 'string' ? details['reason'] : undefined;
  const extras = isObject(rawUsage) ? usageExtras(rawUsage) : undefined;
  const native = {
    ...omit(body, [...ECHO_FIELDS, ...profile.echoFields]),
    ...(extras === undefined ? {} : { usage: extras }),
  };
  const served = typeof body['model'] === 'string' ? body['model'] : undefined;
  const pricing = (findModel(provider, request.model) ?? findModel(provider, served ?? ''))
    ?.pricing;
  const multiplier = profile.priceMultiplier(native, request.options ?? {});
  const cost =
    usage === undefined || multiplier === undefined
      ? undefined
      : estimateCost(usage, pricing, { multiplier });
  const response = {
    ...(id === undefined ? {} : { id }),
    provider,
    model: request.model,
    ...(served === undefined || served === request.model ? {} : { responseModel: served }),
    message: {
      role: 'assistant',
      provider,
      api: 'openai-responses',
      model: request.model,
      ...(id === undefined ? {} : { id }),
      timestamp: answer.timestamp,
      content: output,
    },
    stopReason: stopReason(status, incomplete, output),
    ...(incomplete === undefined ? {} : { providerStopReason: incomplete }),
    ...(usage === undefined ? {} : { usage: cost === undefined ? usage : { ...usage, cost } }),
    native,
    durationMs: answer.durationMs,
    timestamp: answer.timestamp,
  };
  // The output is the provider's own items, which the format's types describe.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return response as unknown as LlmResponse<P>;
}

/** Usage as the format reports it: `input_tokens` is every prompt token, cache reads and writes among them. */
export function readUsage(raw: JsonObject): Usage {
  const details = isObject(raw['input_tokens_details']) ? raw['input_tokens_details'] : {};
  const outputDetails = isObject(raw['output_tokens_details']) ? raw['output_tokens_details'] : {};
  const totalInput = tokens(raw['input_tokens']);
  const cacheRead = tokens(details['cached_tokens']);
  const cacheWrite = tokens(details['cache_write_tokens']);
  const output = tokens(raw['output_tokens']);
  const reasoning = tokens(outputDetails['reasoning_tokens']);
  // A model with no cache writes reports none; the uncached rest is still known.
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const input =
    totalInput !== undefined && cacheRead !== undefined && cached <= totalInput
      ? totalInput - cached
      : undefined;
  return {
    ...(totalInput === undefined ? {} : { totalInput }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** What the provider reports in `usage` beyond the counts `readUsage` maps, or undefined. */
function usageExtras(raw: JsonObject): JsonObject | undefined {
  const extras: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = TOKEN_FIELDS[key];
    if (mapped === true || value === null) continue;
    if (mapped === undefined || !isObject(value)) {
      extras[key] = value;
      continue;
    }
    const rest = omit(value, mapped);
    if (Object.keys(rest).length > 0) extras[key] = rest;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/**
 * The format has no stop reason: it reports a status, and the output shows
 * the rest.
 */
function stopReason(
  status: 'completed' | 'incomplete',
  incomplete: string | undefined,
  output: readonly Json[],
): StopReason {
  if (status === 'incomplete') return incomplete === 'content_filter' ? 'content_filter' : 'length';
  if (pendingToolCalls(output).length > 0) return 'tool_use';
  const messages = output.filter((item) => isObject(item) && item['type'] === 'message');
  const refused = messages.some((message) => {
    const content = isObject(message) ? message['content'] : undefined;
    return isArray(content) && content.some((part) => isObject(part) && part['type'] === 'refusal');
  });
  if (refused) return 'refusal';
  const answered = messages.some(
    (message) => isObject(message) && message['phase'] !== 'commentary',
  );
  // Work with no final answer (hosted calls, a program, commentary) goes on when sent back.
  return answered || output.length === 0 ? 'stop' : 'pause_turn';
}
