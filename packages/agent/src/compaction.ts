// An agent's own compaction numbers. The engine has numbers for each model, and compacts in
// one way. An agent can only change the numbers, by model.

import type { KnownModelId, Provider } from './models.ts';

/** In tokens. What each means exactly is the engine's to say. */
export type ModelCompaction = {
  readonly threshold?: number;
  readonly reserve?: number;
};

/**
 * Compaction numbers by model ID, each in place of the engine's own for that model. The
 * models the types know are offered as they are typed; any other ID is taken too.
 */
export type CompactionSettings<P extends Provider = Provider> = {
  readonly [M in KnownModelId<P>]?: ModelCompaction;
} & { readonly [modelId: string]: ModelCompaction };
