// What runs an agent's code. The engine asks two things of it: what the code says of itself,
// and to call one of its functions. Where the code runs, and how it is kept from the engine,
// is the executor's own.

import type { ActorId, AgentDefinition, AgentId, DeploymentId, Json } from '@acentric/protocol';

/** What a function of an agent is told of the actor it runs for. */
export type CallContext = {
  readonly agent: AgentId;
  readonly actor: ActorId;
  readonly configuration: Json | null;
};

/** How a call of an agent's function ended: with what it returned, or with why it did not. */
export type CallResult =
  { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly error: string };

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
