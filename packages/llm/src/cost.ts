// What a completion cost, estimated from its tokens and the model's prices,
// for providers that do not say what they charged.

import type { ModelCost, ModelPricing } from './model.js';
import type { Usage, UsageCost } from './usage.js';

export type CostOptions = {
  /**
   * Scales every price, for where and how the request ran, such as 0.5 for a
   * batch or 1.1 for inference kept in the US. Defaults to 1.
   */
  readonly multiplier?: number;
  /** The part of `usage.cacheWrite` written for an hour, priced at `cacheWrite1h`. */
  readonly cacheWrite1h?: number;
};

/**
 * The estimated cost, or undefined when it cannot be known: no prices, a count
 * that is missing, or tokens in a part the prices do not cover. The prices for
 * the whole request are those of the highest tier its prompt is over.
 */
export function estimateCost(
  usage: Usage,
  pricing: ModelPricing | undefined,
  { multiplier = 1, cacheWrite1h = 0 }: CostOptions = {},
): UsageCost | undefined {
  const { totalInput, input, output, cacheRead, cacheWrite } = usage;
  if (pricing === undefined || totalInput === undefined || input === undefined) return undefined;
  if (output === undefined) return undefined;
  if (cacheWrite1h > (cacheWrite ?? 0)) return undefined;

  let prices: ModelCost = pricing.base;
  for (const tier of pricing.tiers ?? []) {
    if (totalInput > tier.aboveInputTokens) prices = tier.cost;
  }

  const read = part(cacheRead, prices.cacheRead);
  const shortWrite = part(
    cacheWrite === undefined ? undefined : cacheWrite - cacheWrite1h,
    prices.cacheWrite,
  );
  const hourWrite = part(cacheWrite1h, prices.cacheWrite1h);
  if (read === null || shortWrite === null || hourWrite === null) return undefined;
  const written =
    shortWrite === undefined && hourWrite === undefined
      ? undefined
      : (shortWrite ?? 0) + (hourWrite ?? 0);

  const parts = {
    input: price(input, prices.input) * multiplier,
    output: price(output, prices.output) * multiplier,
    ...(read === undefined ? {} : { cacheRead: read * multiplier }),
    ...(written === undefined ? {} : { cacheWrite: written * multiplier }),
  };
  const total = parts.input + parts.output + (parts.cacheRead ?? 0) + (parts.cacheWrite ?? 0);
  return { source: 'estimated', ...parts, total };
}

/** The price of some tokens: undefined when there are none to price, null when they have no price. */
function part(
  tokens: number | undefined,
  perMillion: number | undefined,
): number | undefined | null {
  if (tokens === undefined) return undefined;
  if (tokens === 0) return perMillion === undefined ? undefined : 0;
  return perMillion === undefined ? null : price(tokens, perMillion);
}

function price(tokens: number, perMillion: number): number {
  return (tokens * perMillion) / 1_000_000;
}
