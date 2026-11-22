// An executor for tests: it has no isolation at all, and calls an agent's functions in the
// process it is in. The real one runs an agent's code out of the engine's process.

import type { AgentDefinition, DeploymentId, Json } from '@acentric/protocol';

import type { Bundle, CallContext, CallResult, Executor } from './executor.ts';

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

/**
 * It has its agents from the start, each under a name, and no code: a deploy gives the name of
 * the agent it is to be in place of code, such as `orders@1`.
 */
export class InlineExecutor implements Executor {
  readonly #agents: ReadonlyMap<string, InlineAgent>;
  readonly #loaded = new Map<DeploymentId, InlineAgent>();
  /** Every call that was made, in order. */
  readonly made: { readonly path: string; readonly argument: Json }[] = [];
  /** How many times code was loaded. */
  loads = 0;

  constructor(agents: { readonly [code: string]: InlineAgent }) {
    this.#agents = new Map(Object.entries(agents));
  }

  #agent(deployment: DeploymentId): InlineAgent {
    const agent = this.#loaded.get(deployment);
    if (agent === undefined) throw new Error(`The deployment ${deployment} is not loaded`);
    return agent;
  }

  async load(deployment: DeploymentId, bundle: Bundle): Promise<AgentDefinition> {
    const agent = this.#agents.get(bundle.code);
    if (agent === undefined) {
      throw Object.assign(new Error(`The code does not load: there is no ${bundle.code}`), {
        code: 'invalid_agent',
      });
    }
    this.loads += 1;
    this.#loaded.set(deployment, agent);
    return structuredClone(agent.definition);
  }

  unload(deployment: DeploymentId): void {
    this.#loaded.delete(deployment);
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
