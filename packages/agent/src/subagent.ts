// An agent this agent's actors may spawn. It is named by its ID: it is deployed by itself,
// and is not part of this agent's code.
//
// What an actor of it is created with is this agent's to say, in `params`: `schema` is what
// the model fills in when it spawns one, and `create` turns that, and what is known of the
// actor that spawns, into the new actor's machine, model, reasoning and configuration.

import type { ActorMachine } from './actor.ts';
import type { Context, Machine } from './context.ts';
import type { Reasoning } from './models.ts';
import type { OutputOf, ToolSchema } from './schema.ts';

/**
 * What a spawned actor is created with. Only the subagent's ID is known here, so its model
 * and its configuration are not typed by it: they are checked when the actor is created.
 */
export type Spawned = {
  /**
   * The machine it works on, and where. Left out, it is the machine and the working directory
   * of the actor that spawns it. `null` gives it none.
   */
  readonly machine?: ActorMachine | null;
  /** Left out, the subagent's own default model. */
  readonly modelId?: string;
  /** Left out, the default. */
  readonly reasoning?: Reasoning;
  /** Left out, none: the subagent's own schema fills in what it defaults. */
  readonly configuration?: unknown;
};

/** What `create` is given of the model's: what `schema` returns, and nothing without one. */
export type SpawnArgs<S> = S extends ToolSchema ? OutputOf<S> : undefined;

/**
 * `S` is the schema of what the model fills in at a spawn, and `TConfig` the configuration of
 * the agent that spawns. A subagent with no schema has `unknown` for `S`.
 */
export type SubagentParams<
  S = unknown,
  TConfig = unknown,
  TMachine extends Machine | null = Machine | null,
> = {
  /**
   * What the model gives when it spawns one, described for it. Without it, the model gives
   * nothing, and `create` decides alone.
   */
  readonly schema?: S & ToolSchema;
  /** What the new actor is created with. `context` is of the actor that spawns it. */
  readonly create: (
    args: SpawnArgs<S>,
    context: Context<TConfig, TMachine>,
  ) => Spawned | Promise<Spawned>;
};

export type Subagent<
  S = unknown,
  TConfig = unknown,
  TMachine extends Machine | null = Machine | null,
> = {
  /** The ID of the agent to spawn. */
  readonly id: string;
  /** What the subagent is for, for the model that decides whether to spawn it. */
  readonly description: string;
  /** Without it, one is created with nothing given: on the spawning actor's machine, with the defaults. */
  readonly params?: SubagentParams<S, TConfig, TMachine>;
};

/** A subagent whose params are of any schema: what a list of subagents holds. */
// The arguments are `any` so that subagents of different schemas fit in one list.
export type AnySubagent<
  TConfig = unknown,
  TMachine extends Machine | null = Machine | null,
> = Subagent<any, TConfig, TMachine>;
