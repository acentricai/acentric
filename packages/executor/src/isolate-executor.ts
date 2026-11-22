// The executor that keeps an agent's code apart from the engine. The code runs in V8 isolates
// of workerd processes the executor starts and watches, with only the web platform: `fetch`,
// timers, `crypto`. It has no file system, no processes, none of the engine's memory and none
// of its environment, and reaches the network only as far as it is let.
//
// It keeps honest code where it belongs, and a fault in an agent from being a fault in the
// engine. It is no boundary against code meant to do harm: there is no limit on the CPU or
// the memory of one isolate, and agents in one process share its fate. Code that loops holds
// up the others of its process until the watchdog kills the process, which loses their calls.

import type { Bundle, CallContext, CallResult, Executor } from '@acentric/core';
import {
  SUPPORTED_BUNDLE_PROTOCOLS,
  agentDefinitionSchema,
  supportsBundleProtocol,
} from '@acentric/protocol';
import type { AgentDefinition, DeploymentId, Json } from '@acentric/protocol';

import { BundleError, SandboxLost, UnsupportedProtocol } from './errors.ts';
import type { SecretSource } from './in-process.ts';
import { createPool } from './isolate/pool.ts';
import type { Pool, PoolOptions, PoolStats } from './isolate/pool.ts';

export type IsolateOptions = PoolOptions & {
  /** Gives the value of a secret of an agent's, when its code asks for one. */
  readonly secrets?: SecretSource;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isObject = (value: unknown): value is { readonly [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class IsolateExecutor implements Executor {
  readonly #pool: Pool;
  readonly #secrets: SecretSource;
  /**
   * The code of every deployment it was given: a process that is replaced holds none, and is
   * sent a deployment's code again the next time that deployment is called.
   */
  readonly #bundles = new Map<DeploymentId, Bundle>();

  private constructor(pool: Pool, secrets: SecretSource) {
    this.#pool = pool;
    this.#secrets = secrets;
  }

  /** Starts the processes. Rejects when workerd does not start on this machine. */
  static async start(options: IsolateOptions = {}): Promise<IsolateExecutor> {
    const { secrets, ...pool } = options;
    return new IsolateExecutor(await createPool(pool), secrets ?? (() => undefined));
  }

  async load(deployment: DeploymentId, bundle: Bundle): Promise<AgentDefinition> {
    // In a process kept for this, so that code that is refused never reaches the processes
    // agents run in.
    const said = await this.#pool.inspect(bundle.code);
    if (!isObject(said)) throw new BundleError('The code said nothing of what it is');
    if (typeof said['error'] === 'string') throw new BundleError(said['error']);
    const protocol = said['protocol'];
    if (typeof protocol !== 'number' || !supportsBundleProtocol(protocol)) {
      throw new UnsupportedProtocol(protocol, SUPPORTED_BUNDLE_PROTOCOLS);
    }
    let definition: AgentDefinition;
    try {
      definition = agentDefinitionSchema.parse(said['definition']);
    } catch (error) {
      throw new BundleError(messageOf(error), { cause: error });
    }
    // Loaded again, a deployment is the same module as before: its code never changes.
    this.#bundles.set(deployment, bundle);
    return definition;
  }

  unload(deployment: DeploymentId): void {
    if (this.#bundles.delete(deployment)) this.#pool.forget(deployment);
  }

  async call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult> {
    const bundle = this.#bundles.get(deployment);
    if (bundle === undefined) throw new Error(`The deployment ${deployment} is not loaded`);
    const { agent } = bundle;
    try {
      const outcome = await this.#pool.call(
        // The deployment, not its code: two deployments of the same code share nothing.
        { key: deployment, code: () => Promise.resolve(bundle.code) },
        {
          path,
          argument,
          context: { ...context, agentName: agent.name },
          secrets: async (name) => this.#secrets(agent.id, name),
          signal,
        },
      );
      if (!isObject(outcome) || typeof outcome['ok'] !== 'boolean') {
        const message = 'The agent’s code answered with what is no answer';
        return { ok: false, kind: 'error', error: { name: 'Error', message } };
      }
      return outcome as unknown as CallResult;
    } catch (error) {
      if (signal.aborted) {
        const message = 'The call was stopped';
        return { ok: false, kind: 'error', error: { name: 'AbortError', message } };
      }
      // The process died with the call in it: whether the code did anything is not known.
      if (error instanceof SandboxLost) return { ok: false, kind: 'lost', reason: error.message };
      const name = error instanceof Error ? error.name : 'Error';
      return { ok: false, kind: 'error', error: { name, message: messageOf(error) } };
    }
  }

  /** What each process is doing, and whether they hold what is in use. */
  stats(): PoolStats {
    return this.#pool.stats();
  }

  /** Kills every process. Calls in flight end as lost. */
  close(): Promise<void> {
    return this.#pool.close();
  }

  /** The pool, for the tests of this package. */
  get pool(): Pool {
    return this.#pool;
  }
}
