// A message of Anthropic's, read into an answer.

import type {
  AssistantMessage,
  Json,
  JsonObject,
  StopReason,
  Usage,
  UsageCost,
} from '@acentric/protocol';

import { estimateCost, withSearches } from '../catalog.ts';
import type { ModelInfo } from '../catalog.ts';
import { ModelFailure } from '../failure.ts';
import { isArray, isObject, tokens } from '../json.ts';
import type { ModelAnswer, ModelStep } from '../runner.ts';
import { toolCalls } from './read.ts';
import { MESSAGES_API, PROVIDER } from './request.ts';

const STOP_REASONS: { readonly [reason: string]: StopReason } = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_use',
  pause_turn: 'pause_turn',
  // It paused after shortening the conversation: sending the message back goes on.
  compaction: 'pause_turn',
  refusal: 'refusal',
};

/** The only kinds of refusal before any output that are charged for. */
const BILLED_REFUSALS: ReadonlySet<string> = new Set([
  'bio',
  'frontier_llm',
  'reasoning_extraction',
]);

/** What one search of Anthropic's own web search costs, in dollars. */
const SEARCH_PRICE = 0.01;

/** The tokens of one sampling. `input_tokens` is only what was not cached. */
function counts(raw: JsonObject): Usage {
  const input = tokens(raw['input_tokens']);
  const output = tokens(raw['output_tokens']);
  // The cache counts are left out when nothing was cached.
  const read = raw['cache_read_input_tokens'];
  const written = raw['cache_creation_input_tokens'];
  const cacheRead = read === undefined || read === null ? 0 : tokens(read);
  const cacheWrite = written === undefined || written === null ? 0 : tokens(written);
  const totalInput =
    input === undefined || cacheRead === undefined || cacheWrite === undefined
      ? undefined
      : input + cacheRead + cacheWrite;
  return {
    ...(totalInput === undefined ? {} : { totalInput }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

type Sampling = {
  readonly model: string | undefined;
  readonly usage: Usage;
  /** What was written to the cache for an hour. Undefined when the writes are not told apart. */
  readonly cacheWrite1h: number | undefined;
};

function hourWrites(raw: JsonObject): number | undefined {
  if (raw['cache_creation_input_tokens'] === undefined || raw['cache_creation_input_tokens'] === 0)
    return 0;
  const split = raw['cache_creation'];
  return isObject(split) ? tokens(split['ephemeral_1h_input_tokens'] ?? 0) : undefined;
}

/** Where a request sampled more than once, each sampling: together they are the whole bill. */
function samplings(raw: JsonObject): Sampling[] | undefined {
  const iterations = raw['iterations'];
  if (!isArray(iterations) || iterations.length === 0) return undefined;
  return iterations.filter(isObject).map((iteration) => ({
    model: typeof iteration['model'] === 'string' ? iteration['model'] : undefined,
    usage: counts(iteration),
    cacheWrite1h: hourWrites(iteration),
  }));
}

const COUNTED = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;

export function readUsage(raw: JsonObject): Usage {
  const each = samplings(raw);
  let counted: Usage = counts(raw);
  if (each !== undefined) {
    const total: { [key: string]: number } = {};
    for (const key of COUNTED) {
      if (each.every((one) => one.usage[key] !== undefined)) {
        total[key] = each.reduce((all, one) => all + (one.usage[key] ?? 0), 0);
      }
    }
    counted = total;
  }
  const details = isObject(raw['output_tokens_details']) ? raw['output_tokens_details'] : {};
  const reasoning = tokens(details['thinking_tokens']);
  const server = isObject(raw['server_tool_use']) ? raw['server_tool_use'] : {};
  const webSearches = tokens(server['web_search_requests']);
  return {
    ...counted,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(webSearches === undefined || webSearches === 0 ? {} : { webSearches }),
  };
}

/**
 * Standard prices hold unless the response says otherwise: kept in the US costs 1.1 times as
 * much, fast mode twice, a batch half. Another tier has no published price.
 */
function priceMultiplier(raw: JsonObject): number | undefined {
  let multiplier = 1;
  const tier = raw['service_tier'];
  if (tier === 'batch') multiplier *= 0.5;
  else if (tier !== undefined && tier !== null && tier !== 'standard') return undefined;
  if (raw['inference_geo'] === 'us') multiplier *= 1.1;
  if (raw['speed'] === 'fast') multiplier *= 2;
  return multiplier;
}

/** The cost at standard prices, each sampling at its own model's. Undefined when a part has no price. */
function estimate(
  raw: JsonObject,
  served: string,
  models: readonly ModelInfo[],
): UsageCost | undefined {
  const multiplier = priceMultiplier(raw);
  if (multiplier === undefined) return undefined;
  const each = samplings(raw) ?? [
    { model: served, usage: counts(raw), cacheWrite1h: hourWrites(raw) },
  ];
  const total: { [part: string]: number } = {};
  for (const { model, usage, cacheWrite1h } of each) {
    if (cacheWrite1h === undefined) return undefined;
    const pricing = models.find((known) => known.id === (model ?? served))?.pricing;
    const cost = estimateCost(usage, pricing, { multiplier, cacheWrite1h });
    if (cost === undefined) return undefined;
    for (const part of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      const value = cost[part];
      if (value !== undefined) total[part] = (total[part] ?? 0) + value;
    }
  }
  return { source: 'estimated', total: 0, ...total };
}

/** A refusal before any output, of a kind Anthropic does not charge for. */
function freeRefusal(body: JsonObject): boolean {
  const content = body['content'];
  if (body['stop_reason'] !== 'refusal' || !isArray(content) || content.length > 0) return false;
  const details = body['stop_details'];
  const category = isObject(details) ? details['category'] : undefined;
  return typeof category !== 'string' || !BILLED_REFUSALS.has(category);
}

export function readAnswer(
  step: ModelStep,
  body: Json | undefined,
  models: readonly ModelInfo[],
): ModelAnswer {
  if (!isObject(body) || body['type'] !== 'message' || !isArray(body['content'])) {
    throw new ModelFailure('Anthropic did not answer with a message', 'invalid_response', {
      provider: PROVIDER,
    });
  }
  const content = body['content'].filter(isObject);
  const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : undefined;
  const stop = typeof body['stop_reason'] === 'string' ? body['stop_reason'] : undefined;
  const served = typeof body['model'] === 'string' ? body['model'] : step.model;
  const rawUsage = isObject(body['usage']) ? body['usage'] : undefined;
  const usage = rawUsage === undefined ? undefined : readUsage(rawUsage);
  const cost =
    rawUsage === undefined || freeRefusal(body)
      ? undefined
      : withSearches(estimate(rawUsage, served, models), usage, SEARCH_PRICE);

  const message: AssistantMessage = {
    role: 'assistant',
    provider: PROVIDER,
    api: MESSAGES_API,
    model: step.model,
    content,
    ...(id === undefined ? {} : { id }),
  };
  return {
    message,
    stopReason: (stop === undefined ? undefined : STOP_REASONS[stop]) ?? 'stop',
    toolCalls: toolCalls(content),
    ...(usage === undefined ? {} : { usage: cost === undefined ? usage : { ...usage, cost } }),
  };
}
