// What is known about a model: its limits, what it takes as input and its
// prices, in US dollars per million tokens.

import type { KnownModelId, Provider } from './providers.js';

export type Modality = 'text' | 'image' | 'file';

/** US dollars per million tokens. */
export type ModelCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  /** Writing to the cache, for the provider's default time to live. */
  readonly cacheWrite?: number;
  /** Writing to the cache for an hour, where a provider prices it apart (Anthropic). */
  readonly cacheWrite1h?: number;
};

export type ModelPricing = {
  readonly base: ModelCost;
  /**
   * Prices for the whole request once its prompt is over a number of tokens,
   * in ascending order.
   */
  readonly tiers?: readonly { readonly aboveInputTokens: number; readonly cost: ModelCost }[];
};

/** One model. */
export type ModelInfo<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly id: KnownModelId<P>;
      readonly name: string;
      /** The most tokens it reads, prompt and output together. */
      readonly contextWindow?: number;
      /** The most tokens it writes in one reply. */
      readonly maxOutputTokens?: number;
      readonly input?: readonly Modality[];
      readonly pricing?: ModelPricing;
    }
  : never;
