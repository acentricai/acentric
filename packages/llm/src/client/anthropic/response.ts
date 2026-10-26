// An Anthropic answer read into an LlmResponse.

import type { JsonObject } from '@acentric/types';

import { estimateCost } from '../../cost.js';
import { isArray, isObject } from '../../json.js';
import { findModel } from '../../models.js';
import type { LlmRequest } from '../../request.js';
import type { LlmResponse, StopReason } from '../../response.js';
import type { Usage, UsageCost } from '../../usage.js';
import type { JsonAnswer } from '../http.js';
import { invalidResponse, omit, tokens } from '../util.js';

const PROVIDER = 'anthropic';

/** Response fields the response already holds elsewhere. */
const ENVELOPE_FIELDS = ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'usage'];

/** Usage fields mapped to `Usage`; the rest of `usage` stays in `native`. */
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens_details',
];

const STOP_REASONS: { readonly [reason: string]: StopReason } = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_use',
  pause_turn: 'pause_turn',
  // Compaction paused after summarizing; sending the message back goes on.
  compaction: 'pause_turn',
  refusal: 'refusal',
};

/** The only categories in which a refusal before any output is billed. */
const BILLED_REFUSALS: ReadonlySet<string> = new Set([
  'bio',
  'frontier_llm',
  'reasoning_extraction',
]);

export function parseResponse(
  request: LlmRequest<'anthropic'>,
  answer: JsonAnswer,
): LlmResponse<'anthropic'> {
  const body = answer.body;
  if (!isObject(body) || body['type'] !== 'message' || !isArray(body['content'])) {
    throw invalidResponse(PROVIDER, 'Anthropic did not answer with a message', body);
  }
  const content = body['content'];
  const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : undefined;
  const stop = typeof body['stop_reason'] === 'string' ? body['stop_reason'] : undefined;
  const stopReason = (stop === undefined ? undefined : STOP_REASONS[stop]) ?? 'stop';
  const served = typeof body['model'] === 'string' ? body['model'] : request.model;
  const rawUsage = isObject(body['usage']) ? body['usage'] : undefined;
  const usage = rawUsage === undefined ? undefined : readUsage(rawUsage);
  const cost =
    rawUsage === undefined || freeRefusal(body) ? undefined : estimate(rawUsage, served, request);

  // How cache writes split by time to live says nothing when nothing was written.
  const extras =
    rawUsage === undefined
      ? undefined
      : omit(
          rawUsage,
          usage?.cacheWrite === 0 ? [...USAGE_FIELDS, 'cache_creation'] : USAGE_FIELDS,
        );
  const native = {
    ...omit(body, ENVELOPE_FIELDS),
    ...(extras === undefined || Object.keys(extras).length === 0 ? {} : { usage: extras }),
  };
  const response = {
    ...(id === undefined ? {} : { id }),
    provider: PROVIDER,
    model: request.model,
    ...(served === request.model ? {} : { responseModel: served }),
    message: {
      role: 'assistant',
      provider: PROVIDER,
      api: 'anthropic-messages',
      model: request.model,
      ...(id === undefined ? {} : { id }),
      timestamp: answer.timestamp,
      content,
    },
    stopReason,
    ...(stop === undefined || stop === stopReason ? {} : { providerStopReason: stop }),
    ...(usage === undefined ? {} : { usage: cost === undefined ? usage : { ...usage, cost } }),
    native,
    durationMs: answer.durationMs,
    timestamp: answer.timestamp,
  };
  // The content is Anthropic's own blocks, which the format's types describe.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return response as unknown as LlmResponse<'anthropic'>;
}

/**
 * Usage as the format reports it: `input_tokens` is only the uncached part.
 * Where a request sampled more than once (compaction, a fallback model), the
 * iterations hold the whole bill and the top-level counts leave some out.
 */
export function readUsage(raw: JsonObject): Usage {
  const iterations = samplings(raw);
  const counted = iterations === undefined ? counts(raw) : sum(iterations.map((one) => one.usage));
  const details = isObject(raw['output_tokens_details']) ? raw['output_tokens_details'] : {};
  const reasoning = tokens(details['thinking_tokens']);
  return { ...counted, ...(reasoning === undefined ? {} : { reasoning }) };
}

/** One sampling's tokens. */
function counts(raw: JsonObject): Usage {
  const input = tokens(raw['input_tokens']);
  const output = tokens(raw['output_tokens']);
  // Anthropic leaves the cache counts out when nothing was cached.
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
  /** Undefined when cache writes are not split by time to live. */
  readonly cacheWrite1h: number | undefined;
};

function samplings(raw: JsonObject): Sampling[] | undefined {
  const iterations = raw['iterations'];
  if (!isArray(iterations) || iterations.length === 0) return undefined;
  return iterations.filter(isObject).map((iteration) => {
    const model = iteration['model'];
    return {
      model: typeof model === 'string' ? model : undefined,
      usage: counts(iteration),
      cacheWrite1h: hourWrites(iteration),
    };
  });
}

function hourWrites(raw: JsonObject): number | undefined {
  if (!raw['cache_creation_input_tokens']) return 0;
  const split = raw['cache_creation'];
  return isObject(split) ? tokens(split['ephemeral_1h_input_tokens'] ?? 0) : undefined;
}

function sum(usages: readonly Usage[]): Usage {
  const keys = ['totalInput', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;
  const total: { [key: string]: number } = {};
  for (const key of keys) {
    if (usages.every((usage) => usage[key] !== undefined)) {
      total[key] = usages.reduce((all, usage) => all + (usage[key] ?? 0), 0);
    }
  }
  return total;
}

/**
 * The cost at standard prices, each sampling at its own model's prices and
 * long-context tier, times the multiplier for where and how it ran. Undefined
 * when any part cannot be priced.
 */
function estimate(
  raw: JsonObject,
  served: string,
  request: LlmRequest<'anthropic'>,
): UsageCost | undefined {
  const multiplier = priceMultiplier(raw, request);
  if (multiplier === undefined) return undefined;
  const each = samplings(raw) ?? [
    { model: served, usage: counts(raw), cacheWrite1h: hourWrites(raw) },
  ];
  const costs: UsageCost[] = [];
  for (const { model, usage, cacheWrite1h } of each) {
    if (cacheWrite1h === undefined) return undefined;
    const pricing = findModel(PROVIDER, model ?? served)?.pricing;
    const cost = estimateCost(usage, pricing, { multiplier, cacheWrite1h });
    if (cost === undefined) return undefined;
    costs.push(cost);
  }
  const [first] = costs;
  if (costs.length === 1 && first !== undefined) return first;
  const parts = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
  const total: { [key: string]: number } = {};
  for (const cost of costs) {
    for (const part of parts) {
      const value = cost[part];
      if (value !== undefined) total[part] = (total[part] ?? 0) + value;
    }
  }
  return { source: 'estimated', total: 0, ...total };
}

/**
 * Standard prices hold unless the response says otherwise: inference kept in
 * the US costs 1.1 times as much, fast mode twice, a batch half. Priority Tier
 * has no published price.
 */
function priceMultiplier(raw: JsonObject, request: LlmRequest<'anthropic'>): number | undefined {
  let multiplier = 1;
  const tier = raw['service_tier'];
  if (tier === 'batch') multiplier *= 0.5;
  else if (tier !== undefined && tier !== null && tier !== 'standard') return undefined;
  if (raw['inference_geo'] === 'us') multiplier *= 1.1;
  const speed = raw['speed'];
  if (speed === 'fast') multiplier *= 2;
  else if ((speed === undefined || speed === null) && request.options?.speed === 'fast')
    return undefined;
  return multiplier;
}

/** A refusal before any output, in a category Anthropic does not bill. */
function freeRefusal(body: JsonObject): boolean {
  const content = body['content'];
  if (body['stop_reason'] !== 'refusal' || !isArray(content) || content.length > 0) return false;
  const details = body['stop_details'];
  const category = isObject(details) ? details['category'] : undefined;
  return typeof category !== 'string' || !BILLED_REFUSALS.has(category);
}
