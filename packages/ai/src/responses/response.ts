// A response in the Responses format, read into an answer.

import type { AssistantMessage, Json, JsonObject, StopReason, Usage } from '@acentric/protocol';

import { estimateCost, withSearches } from '../catalog.ts';
import { ModelFailure } from '../failure.ts';
import { isArray, isObject, tokens } from '../json.ts';
import type { ModelAnswer, ModelStep } from '../runner.ts';
import { failedResponse } from './errors.ts';
import type { ResponsesProfile } from './profile.ts';
import { refused, toolCalls } from './read.ts';
import { RESPONSES_API } from './request.ts';

/** Usage as the format reports it: `input_tokens` is every prompt token, cached ones among them. */
export function readUsage(raw: JsonObject): Usage {
  const details = isObject(raw['input_tokens_details']) ? raw['input_tokens_details'] : {};
  const outputDetails = isObject(raw['output_tokens_details']) ? raw['output_tokens_details'] : {};
  const totalInput = tokens(raw['input_tokens']);
  const cacheRead = tokens(details['cached_tokens']);
  const cacheWrite = tokens(details['cache_write_tokens']);
  const output = tokens(raw['output_tokens']);
  const reasoning = tokens(outputDetails['reasoning_tokens']);
  // A model with no cache writes reports none; the rest, which was not cached, is still known.
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

/** The format has no reason for stopping: it has a status, and the output shows the rest. */
function stopReason(
  status: string,
  incomplete: string | undefined,
  output: readonly Json[],
  calls: number,
): StopReason {
  if (status === 'incomplete') return incomplete === 'content_filter' ? 'content_filter' : 'length';
  if (calls > 0) return 'tool_use';
  if (refused(output)) return 'refusal';
  const answered = output.some(
    (item) => isObject(item) && item['type'] === 'message' && item['phase'] !== 'commentary',
  );
  // Work with no answer at its end (the provider's own calls, word of progress) goes on when sent back.
  return answered || output.length === 0 ? 'stop' : 'pause_turn';
}

export function readAnswer(
  step: ModelStep,
  body: Json | undefined,
  profile: ResponsesProfile,
): ModelAnswer {
  const { id: provider, label } = profile;
  const invalid = (said: string) => new ModelFailure(said, 'invalid_response', { provider });
  if (!isObject(body)) throw invalid(`${label} did not answer with a response`);

  // A failure can come with HTTP 200, as a response that failed or as an error alone.
  const error = body['error'];
  if (body['status'] === 'failed' || (error !== null && error !== undefined)) {
    throw failedResponse(profile, error ?? null);
  }
  const output = body['output'];
  const status = body['status'];
  if (body['object'] !== 'response' || !isArray(output))
    throw invalid(`${label} did not answer with a response`);
  if (status !== 'completed' && status !== 'incomplete') {
    throw invalid(`${label} answered with a response that is ${String(status)}, not finished`);
  }
  const items = output.filter(isObject);

  const rawUsage = body['usage'];
  const counted = isObject(rawUsage) ? readUsage(rawUsage) : undefined;
  // Each search of the provider's own web search is charged for, and the usage does not count them.
  const searches = items.filter((item) => item['type'] === 'web_search_call').length;
  const usage =
    counted === undefined || searches === 0 ? counted : { ...counted, webSearches: searches };
  const served = typeof body['model'] === 'string' ? body['model'] : '';
  const pricing = (
    profile.models.find((model) => model.id === step.model) ??
    profile.models.find((model) => model.id === served)
  )?.pricing;
  const multiplier = profile.priceMultiplier(body);
  const cost =
    usage === undefined || multiplier === undefined
      ? undefined
      : withSearches(estimateCost(usage, pricing, { multiplier }), usage, profile.searchPrice);

  const details = body['incomplete_details'];
  const incomplete =
    isObject(details) && typeof details['reason'] === 'string' ? details['reason'] : undefined;
  const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : undefined;
  const calls = toolCalls(items);
  const message: AssistantMessage = {
    role: 'assistant',
    provider,
    api: RESPONSES_API,
    model: step.model,
    content: items,
    ...(id === undefined ? {} : { id }),
  };
  return {
    message,
    stopReason: stopReason(status, incomplete, items, calls.length),
    toolCalls: calls,
    ...(usage === undefined ? {} : { usage: cost === undefined ? usage : { ...usage, cost } }),
  };
}
