// What an actor is created with. None of it is in the agent's definition.

import type { ModelId, Provider, Reasoning } from './models.ts';

/** The machine an actor works on, and where. */
export type ActorMachine = {
  /** The machine's ID. */
  readonly id: string;
  /**
   * The actor's working directory on the machine: where its commands start. An absolute path,
   * or one that starts with `~`, the home directory there.
   */
  readonly cwd: string;
  /**
   * Environment variables every command of the actor is run with, by name. They are set over
   * the machine's own. The engine keeps their values sealed, and gives only their names to
   * whoever reads the actor.
   */
  readonly env?: { readonly [name: string]: string };
};

/**
 * `P` is the agent's provider, `TConfigInput` what its `configuration` schema takes, and `M`
 * whether its actors work on a machine. An agent with no `configuration` schema takes none.
 */
export type CreateActor<
  P extends Provider = Provider,
  TConfigInput = undefined,
  M extends boolean = boolean,
> = {
  /** What people call the actor. Without it, it has no name. */
  readonly name?: string;
  /** The caller's own ID for it. Creating with one an actor of the agent has gives that actor back. */
  readonly externalId?: string;
  /** The model the actor runs on. Without it, the provider's default. */
  readonly modelId?: ModelId<P>;
  /** How hard the model thinks. Without it, the default. */
  readonly reasoning?: Reasoning;
} & (boolean extends M
  ? {
      /** The machine the actor works on, with its working directory. Without it, it has none. */
      readonly machine?: ActorMachine;
    }
  : M extends true
    ? {
        /** The machine the actor works on, with its working directory: its agent's actors all have one. */
        readonly machine: ActorMachine;
      }
    : { readonly machine?: never }) &
  ([TConfigInput] extends [undefined]
    ? { readonly configuration?: never }
    : undefined extends TConfigInput
      ? { readonly configuration?: TConfigInput }
      : { readonly configuration: TConfigInput });
