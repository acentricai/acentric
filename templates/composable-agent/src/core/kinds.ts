// The runners' built-in kinds the agent uses. The memory and local runners
// both provide `@timer` in this shape.

export type RunnerKinds = {
  /** Fires at `at`, in milliseconds since the Unix epoch, and returns null. */
  '@timer': { args: { at: number }; result: null };
};
