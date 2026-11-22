// An executor for tests: it has no isolation at all, and calls an agent's functions in the
// process it is in. The real one runs an agent's code out of the engine's process.

import type { AgentDefinition, DeploymentId, Json } from '@acentric/protocol';

import type { CallContext, CallResult, Executor } from './executor.ts';

/** A function of an agent, as its code would have it. */
export type AgentFunction = (
  argument: Json,
  context: CallContext,
  signal: AbortSignal,
) => Json | Promise<Json>;

export type InlineAgent = {
  readonly definition: AgentDefinition;
  /** Its functions by path, such as `tools.lookup_order.execute`. */
  readonly functions: { readonly [path: string]: AgentFunction };
};

export class InlineExecutor implements Executor {
  readonly #agents: ReadonlyMap<DeploymentId, InlineAgent>;
  /** Every call that was made, in order. */
  readonly made: { readonly path: string; readonly argument: Json }[] = [];
  /** How many times each deployment was asked what it is. */
  described = 0;

  constructor(agents: ReadonlyMap<DeploymentId, InlineAgent>) {
    this.#agents = agents;
  }

  #agent(deployment: DeploymentId): InlineAgent {
    const agent = this.#agents.get(deployment);
    if (agent === undefined) throw new Error(`There is no deployment ${deployment}`);
    return agent;
  }

  async describe(deployment: DeploymentId): Promise<AgentDefinition> {
    this.described += 1;
    return structuredClone(this.#agent(deployment).definition);
  }

  async call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult> {
    const called = this.#agent(deployment).functions[path];
    if (called === undefined) {
      const message = `The agent has no ${path}`;
      return { ok: false, kind: 'error', error: { name: 'Error', message } };
    }
    this.made.push({ path, argument: structuredClone(argument) });
    try {
      return { ok: true, value: await called(argument, context, signal) };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: 'error', error: { name, message } };
    }
  }
}
