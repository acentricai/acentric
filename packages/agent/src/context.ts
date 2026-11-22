// What an agent's own code is given: every tool's `execute`, every input's `handler`, and an
// MCP server's `headers` when it is a function.

import type { ActorMachine } from './actor.ts';
import type { Reasoning } from './models.ts';

/** Reads the agent's secrets by name. They are set on the engine, never in the agent's code. */
export type Secrets = {
  /**
   * The secret's value. Rejects with an Error named `SecretNotSet` when no secret has this
   * name, so a caller can fall back to another.
   */
  get(name: string): Promise<string>;
};

/** No secret of the agent's has the name that was asked for. */
export class SecretNotSet extends Error {
  override readonly name = 'SecretNotSet';
  constructor(secret: string) {
    super(`The agent has no secret named ${secret}`);
  }
}

/**
 * The machine an actor works on, as its agent's code has it: where it is, and its files. A
 * path is from the actor's working directory, unless it is absolute or starts with `~`.
 */
export type Machine = ActorMachine & {
  /** The file's bytes. Throws when there is none, or the machine is not connected. */
  read(path: string): Promise<Uint8Array>;
  /** The file's text, as UTF-8. */
  readText(path: string): Promise<string>;
  /** Puts `data` in place of what the file had, or makes it, and the folders it needs. */
  write(path: string, data: string | Uint8Array): Promise<void>;
};

/**
 * The machine of an actor whose agent says `machine: M`: there with `true`, `null` with
 * `false`, and either where the agent is not known, as for a tool written apart from it.
 */
export type MachineOf<M extends boolean> = boolean extends M
  ? Machine | null
  : M extends true
    ? Machine
    : null;

/**
 * `TConfig` is the actor's configuration, as the agent's `configuration` schema returned it,
 * and `TMachine` its machine: `MachineOf` whether its agent's actors work on one.
 */
export type Context<TConfig = unknown, TMachine extends Machine | null = Machine | null> = {
  /** The ID of the agent: the engine's own, which never changes. */
  readonly agent: string;
  /** What people call the agent. It can be changed. */
  readonly agentName: string;
  /** The ID of the actor this code runs for: the engine's own, which never changes. */
  readonly actor: string;
  /** What people call the actor. Null for one with no name. */
  readonly actorName: string | null;
  /** The caller's own ID for the actor: what it was created with. Null for one with none. */
  readonly externalId: string | null;
  /** What the actor was created with. `undefined` for an agent with no `configuration` schema. */
  readonly configuration: TConfig;
  /** The model the actor runs on. */
  readonly modelId: string;
  /** How hard the actor's model thinks. */
  readonly reasoning: Reasoning;
  /** The machine the actor works on, its working directory there, and its files. `null` when it has none. */
  readonly machine: TMachine;
  readonly secrets: Secrets;
};
