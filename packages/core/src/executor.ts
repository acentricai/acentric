// What runs an agent's code. The engine gives it the code of a deployment, which it loads and
// asks what it is, and then has it call the code's functions. Where the code runs, and how it
// is kept from the engine, is the executor's own.

import type {
  Actor,
  ActorId,
  AgentDefinition,
  AgentId,
  CallIssue,
  CallOutcome,
  DeploymentId,
  MachineFilePart,
  MachineFileRequest,
  Json,
  MachineId,
  Reasoning,
} from '@acentric/protocol';

/**
 * What a function of an agent is told of the actor it runs for, as far as the engine has it.
 * The executor adds what it knows itself: what the agent is called.
 */
export type CallContext = {
  readonly agent: AgentId;
  readonly actor: ActorId;
  readonly actorName: string | null;
  readonly externalId: string | null;
  readonly configuration: Json | null;
  readonly modelId: string;
  readonly reasoning: Reasoning;
  /**
   * The machine the actor works on, and its working directory there. Null for one that has
   * none. The engine adds the variables its commands are run with as it makes the call.
   */
  readonly machine: {
    readonly id: MachineId;
    readonly cwd: string;
    readonly env?: { readonly [name: string]: string };
  } | null;
};

/** The context of a call for an actor. */
export function contextOf(actor: Actor): CallContext {
  return {
    agent: actor.agent,
    actor: actor.id,
    actorName: actor.name,
    externalId: actor.externalId,
    configuration: actor.configuration,
    modelId: actor.modelId,
    reasoning: actor.reasoning,
    machine: actor.machine === null ? null : { id: actor.machine.id, cwd: actor.machine.cwd },
  };
}

/**
 * What the engine does for one call's code while it runs, which the executor cannot do itself.
 * It is of that call alone: the machine is the one of the actor the call is for, and its code
 * names none.
 */
export type CallHost = {
  /**
   * Reads or writes a part of a file of the actor's machine. Rejects with what went wrong,
   * which the code is told.
   */
  file(request: MachineFileRequest): Promise<MachineFilePart | undefined>;
};

/** What the engine does for a call of an actor that has no machine: nothing. */
export const NO_MACHINE: CallHost = {
  file: () => Promise.reject(new Error('The actor has no machine')),
};

/**
 * How a call of an agent's function ended: with what it returned, with what its schema found
 * wrong with what it was given, or with what the code threw. Or it has no end that is known:
 * what ran the code died with the call in it, and the code may or may not have run.
 */
export type CallResult =
  CallOutcome | { readonly ok: false; readonly kind: 'lost'; readonly reason: string };

/** What a schema found wrong, as a line to read: where, then what. */
export function issuesText(issues: readonly CallIssue[]): string {
  return issues
    .map((issue) =>
      issue.path === undefined || issue.path.length === 0
        ? issue.message
        : `${issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/** The code of a deployment, and the agent it is a deployment of. */
export type Bundle = {
  /** One ES module, with everything it needs inside it. */
  readonly code: string;
  readonly agent: { readonly id: AgentId; readonly name: string };
};

export interface Executor {
  /**
   * Takes the code of a deployment, and gives what the code says of itself. It is asked
   * before a deployment is first called, and may be asked again for one it has. Rejects, with
   * why, when the code is not an agent: an error whose `code` is `invalid_agent` or
   * `unsupported_protocol`.
   */
  load(deployment: DeploymentId, bundle: Bundle): Promise<AgentDefinition>;
  /** Forgets a deployment: one that was refused after it was loaded, or whose agent is gone. */
  unload(deployment: DeploymentId): void | Promise<void>;
  /**
   * Calls a function of the deployment's code by its path, such as
   * `tools.lookup_order.execute`. It answers as soon as it can when `signal` is aborted, as a
   * call that ended with an `AbortError`.
   */
  call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
    host: CallHost,
  ): Promise<CallResult>;
}
