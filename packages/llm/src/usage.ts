// Tokens and cost, the same for every provider.

/** Token counts. A count the provider does not report is left out; zero is a known zero. */
export type Usage = {
  /** Every prompt token, cached or not. */
  readonly totalInput?: number;
  /** Prompt tokens neither read from nor written to a cache. */
  readonly input?: number;
  /** Output tokens, reasoning included where the provider counts it as output. */
  readonly output?: number;
  /** Reasoning tokens: part of `output` unless the provider bills them apart. */
  readonly reasoning?: number;
  readonly cacheRead?: number;
  /** Every token written to a cache, whatever its time to live. */
  readonly cacheWrite?: number;
  /**
   * What it cost: what the provider says it charged where it says so,
   * otherwise estimated from the model's prices when they and every count
   * needed are known.
   */
  readonly cost?: UsageCost;
};

/** US dollars. A part that is not known is left out. */
export type UsageCost = {
  /** `reported`: what the provider says it charged. `estimated`: tokens at known prices. */
  readonly source: 'reported' | 'estimated';
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total: number;
};
