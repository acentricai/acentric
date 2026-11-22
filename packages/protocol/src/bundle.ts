// What the engine and an agent's deployed code say to each other: the bundle protocol.
//
// The engine asks two things and no more: "say what you are", and "call this function of
// yours". The code asks one thing back while it is called: the value of a secret.
//
// The code that answers is the framework's, and is in every bundle. So a bundle speaks the
// protocol of the framework it was built with, and says which: the engine never reads an
// agent's own objects.
//
// This file has no schemas in it, and nothing it imports at run time has: an agent's bundle
// carries it, and is to stay small.

import type { ActorId, AgentId } from './ids.ts';
import type { Json } from './json.ts';
import type { AgentDefinition } from './manifest.ts';
import type { Reasoning } from './messages.ts';

export { BUNDLE_PROTOCOL } from './versions.ts';

/**
 * Where a bundle's entry is found: the default export of the bundle has it under
 * `Symbol.for(BUNDLE_ENTRY)`.
 */
export const BUNDLE_ENTRY = 'acentric.bundle';

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
};

/** What the engine does for the code while it is called. */
export type BundleHost = {
  /** The value of a secret of the agent's, or undefined when none is set by that name. */
  secret(name: string): Promise<string | undefined>;
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
