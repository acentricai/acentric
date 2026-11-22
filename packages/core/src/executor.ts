// What runs an agent's code. The engine asks two things of it: what the code says of itself,
// and to call one of its functions. Where the code runs, and how it is kept from the engine,
// is the executor's own.

import type {
  Actor,
  ActorId,
  AgentDefinition,
  AgentId,
  CallIssue,
  CallOutcome,
  DeploymentId,
  Json,
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
  };
}

/**
 * How a call of an agent's function ended: with what it returned, with what its schema found
 * wrong with what it was given, or with what the code threw.
 */
export type CallResult = CallOutcome;

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

export interface Executor {
  /** What the deployment's code says of itself. It never changes for a deployment. */
  describe(deployment: DeploymentId): Promise<AgentDefinition>;
  /**
   * Calls a function of the deployment's code by its path, such as
   * `tools.lookup_order.execute`. It answers as soon as it can when `signal` is aborted.
   */
  call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult>;
}
