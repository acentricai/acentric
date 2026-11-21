// What is known of a model: its limits, what it reads, and its prices. And what a call cost,
// worked out from its tokens where the provider does not say what it charged.

import type { Usage, UsageCost } from '@acentric/protocol';

/** US dollars for a million tokens. */
export type ModelCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  /** Writing to the cache, for the provider's usual time to live. */
  readonly cacheWrite?: number;
  /** Writing to the cache for an hour, where a provider prices it apart. */
  readonly cacheWrite1h?: number;
};

export type ModelPricing = {
  readonly base: ModelCost;
  /** Prices for the whole request once its prompt is over a number of tokens, lowest first. */
  readonly tiers?: readonly { readonly aboveInputTokens: number; readonly cost: ModelCost }[];
};

export type ModelInfo = {
  readonly id: string;
  readonly name: string;
  /** The most tokens it reads, prompt and answer together. */
  readonly contextWindow?: number;
  /** The most tokens it writes in one answer. */
  readonly maxOutputTokens?: number;
  readonly input?: readonly ('text' | 'image' | 'file')[];
  readonly pricing?: ModelPricing;
};

function price(count: number, perMillion: number): number {
  return (count * perMillion) / 1_000_000;
}

/** The price of some tokens: undefined when there are none to price, null when they have no price. */
function part(
  count: number | undefined,
  perMillion: number | undefined,
): number | undefined | null {
  if (count === undefined) return undefined;
  if (count === 0) return perMillion === undefined ? undefined : 0;
  return perMillion === undefined ? null : price(count, perMillion);
}

/**
 * What a call cost, or undefined when it cannot be known: no prices, a count that is missing,
 * or tokens in a part the prices do not cover. The prices for the whole request are those of
 * the highest tier its prompt is over.
 */
export function estimateCost(
  usage: Usage,
  pricing: ModelPricing | undefined,
  options: { readonly multiplier?: number; readonly cacheWrite1h?: number } = {},
): UsageCost | undefined {
  const { multiplier = 1, cacheWrite1h = 0 } = options;
  const { totalInput, input, output, cacheRead, cacheWrite } = usage;
  if (pricing === undefined || totalInput === undefined || input === undefined) return undefined;
  if (output === undefined || cacheWrite1h > (cacheWrite ?? 0)) return undefined;

  let prices = pricing.base;
  for (const tier of pricing.tiers ?? []) {
    if (totalInput > tier.aboveInputTokens) prices = tier.cost;
  }
  const read = part(cacheRead, prices.cacheRead);
  const short = part(
    cacheWrite === undefined ? undefined : cacheWrite - cacheWrite1h,
    prices.cacheWrite,
  );
  const hour = part(cacheWrite1h, prices.cacheWrite1h);
  if (read === null || short === null || hour === null) return undefined;
  const written =
    short === undefined && hour === undefined ? undefined : (short ?? 0) + (hour ?? 0);

  const parts = {
    input: price(input, prices.input) * multiplier,
    output: price(output, prices.output) * multiplier,
    ...(read === undefined ? {} : { cacheRead: read * multiplier }),
    ...(written === undefined ? {} : { cacheWrite: written * multiplier }),
  };
  const total = parts.input + parts.output + (parts.cacheRead ?? 0) + (parts.cacheWrite ?? 0);
  return { source: 'estimated', ...parts, total };
}

/** A cost with the searches of the provider's own web search added, each at `each` dollars. */
export function withSearches(
  cost: UsageCost | undefined,
  usage: Usage | undefined,
  each: number | undefined,
): UsageCost | undefined {
  const searches = usage?.webSearches ?? 0;
  if (cost === undefined || searches === 0) return cost;
  if (each === undefined) return undefined;
  const webSearch = searches * each;
  return { ...cost, webSearch, total: cost.total + webSearch };
}
