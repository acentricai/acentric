// An agent's instructions: text, the same for every actor, or made for each actor by a
// function of what it was created with.
//
// The function is run once, when the actor is created, and what it returns is the actor's
// instructions from then on. It is run again only when the actor moves to another version of
// its agent, which is between turns. So it is to be pure: what it returns is made of the
// context alone, with no time, no randomness and nothing from outside, and it returns at once.

import type { Reasoning } from './models.ts';

/** Where an actor works, as its instructions are made with it. */
export type InstructionsMachine = {
  /** The ID of the machine. */
  readonly id: string;
  /** The actor's working directory on it. */
  readonly cwd: string;
};

/**
 * The machine of an actor whose agent says `machine: M`, as its instructions are made: there
 * with `true`, `null` with `false`, and either where the agent is not known.
 */
export type InstructionsMachineOf<M extends boolean> = boolean extends M
  ? InstructionsMachine | null
  : M extends true
    ? InstructionsMachine
    : null;

/**
 * What an actor's instructions are made of: what it was created with. `TConfig` is its
 * configuration, as the agent's `configuration` schema returned it. It has no secrets and no
 * machine's files: the function that makes the instructions returns at once.
 */
export type InstructionsContext<TConfig = unknown, M extends boolean = boolean> = {
  /** The ID of the agent: the engine's own, which never changes. */
  readonly agent: string;
  /** What people call the agent. */
  readonly agentName: string;
  /** The ID of the actor: the engine's own, which never changes. */
  readonly actor: string;
  /** What people call the actor. Null for one with no name. */
  readonly actorName: string | null;
  /** The caller's own ID for the actor. Null for one with none. */
  readonly externalId: string | null;
  readonly configuration: TConfig;
  readonly modelId: string;
  readonly reasoning: Reasoning;
  /** The machine it works on, and where: not the variables its commands are run with. */
  readonly machine: InstructionsMachineOf<M>;
};

/**
 * What the model is told, besides what the engine tells it: text, or a function that makes
 * it for each actor from what the actor was created with. The function is pure and not
 * async: it is run once for an actor, when it is created, and again only when the actor moves
 * to another version of its agent.
 */
export type Instructions<TConfig = unknown, M extends boolean = boolean> =
  string | ((context: InstructionsContext<TConfig, M>) => string);
