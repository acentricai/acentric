// What the engine and an agent's deployed code say to each other: the bundle protocol.
//
// The engine asks two things and no more: "say what you are", and "call this function of
// yours". The code asks two things back while it is called: the value of a secret, and a part
// of a file of its actor's machine.
//
// The code that answers is the framework's, and is in every bundle. So a bundle speaks the
// protocol of the framework it was built with, and says which: the engine never reads an
// agent's own objects.
//
// This file has no schemas in it, and nothing it imports at run time has: an agent's bundle
// carries it, and is to stay small.

import type { ActorId, AgentId, MachineId } from './ids.ts';
import type { Json } from './json.ts';
import type { AgentDefinition } from './manifest.ts';
import type { Reasoning } from './messages.ts';

export { BUNDLE_PROTOCOL } from './versions.ts';

/**
 * Where a bundle's entry is found: the default export of the bundle has it under
 * `Symbol.for(BUNDLE_ENTRY)`.
 */
export const BUNDLE_ENTRY = 'acentric.bundle';

/**
 * The most bytes of a file one request of the code's moves: a file is read and written in as
 * many as it takes, so that nothing large is said at once.
 */
export const BUNDLE_FILE_PART = 8 << 20;

/**
 * An actor's machine as its agent's code is given it: with the variables its commands are run
 * with, when it has any.
 */
export type BundleMachine = {
  readonly id: MachineId;
  readonly cwd: string;
  readonly env?: { readonly [name: string]: string };
};

/** What a function of an agent is told of the actor it runs for. */
export type BundleContext = {
  readonly agent: AgentId;
  readonly agentName: string;
  readonly actor: ActorId;
  /** Null for an actor that has no name. */
  readonly actorName: string | null;
  /** The caller's own ID for the actor. Null for one with none. */
  readonly externalId: string | null;
  /** The actor's configuration. Null for an agent that takes none. */
  readonly configuration: Json | null;
  readonly modelId: string;
  readonly reasoning: Reasoning;
  /** The machine the actor works on. Null for an actor that has none, and before there is an actor. */
  readonly machine: BundleMachine | null;
};

/**
 * A part of a file of the actor's machine, read or written. The path is from the actor's
 * working directory, unless it is absolute or starts with `~`.
 */
export type MachineFileRequest =
  /** At most `BUNDLE_FILE_PART` bytes, from the byte `from`. */
  | { readonly op: 'read'; readonly path: string; readonly from: number }
  /**
   * The bytes `data`, in base64, at most `BUNDLE_FILE_PART` of them: in place of all the file
   * had when `from` is 0, and after its end otherwise. `size` is how large the whole file is
   * to be.
   */
  | {
      readonly op: 'write';
      readonly path: string;
      readonly from: number;
      readonly size: number;
      readonly data: string;
    };

/** What a read gives: how large the file is, and the bytes of this part, in base64. */
export type MachineFilePart = { readonly size: number; readonly data: string };

/** What the engine does for the code while it is called. */
export type BundleHost = {
  /** The value of a secret of the agent's, or undefined when none is set by that name. */
  secret(name: string): Promise<string | undefined>;
  /**
   * Reads or writes a part of a file of the actor's machine. A read gives the part, and a
   * write nothing. Rejects with what went wrong: the actor has no machine, the machine is not
   * connected, there is no such file, or the file is larger than the code may move.
   */
  file(request: MachineFileRequest): Promise<MachineFilePart | undefined>;
};

/** One thing wrong with what a function was given, and where in it. */
export type CallIssue = {
  readonly message: string;
  readonly path?: readonly (string | number)[];
};

/** How a call ended. */
export type CallOutcome =
  | { readonly ok: true; readonly value: Json }
  /** What was given failed the schema: the function did not run. */
  | { readonly ok: false; readonly kind: 'invalid'; readonly issues: readonly CallIssue[] }
  /** The agent's code threw. */
  | {
      readonly ok: false;
      readonly kind: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };

/**
 * The functions of an agent the engine calls, by path:
 *
 *   configuration.validate    (value)    what the schema returns for it
 *   tools.<name>.execute      (args)     checks the arguments, then runs the tool
 *   inputs.<type>.handler     (payload)  checks the payload, then runs the handler
 */
export type CallPath = string;

/** What a bundle gives the engine. */
export interface BundleEntry {
  /** The bundle protocol it speaks. */
  readonly protocol: number;
  /** Everything of the agent's definition that is data. Throws when the agent is not one. */
  describe(): AgentDefinition;
  call(
    path: CallPath,
    argument: Json,
    context: BundleContext,
    host: BundleHost,
  ): Promise<CallOutcome>;
}
