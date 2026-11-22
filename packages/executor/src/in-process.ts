// An executor that runs an agent's code in the process it is in. There is nothing between the
// code and the engine: it is for a developer running their own agent on their own computer,
// and for tests. An engine that runs code it did not write uses the executor that keeps it
// apart.
//
// It can stop waiting for a call, and cannot stop the call: the code runs on.

import type { Bundle, CallContext, CallResult, Executor } from '@acentric/core';
import {
  BUNDLE_ENTRY,
  SUPPORTED_BUNDLE_PROTOCOLS,
  agentDefinitionSchema,
  supportsBundleProtocol,
} from '@acentric/protocol';
import type { AgentDefinition, AgentId, BundleEntry, DeploymentId, Json } from '@acentric/protocol';

import { BundleError, UnsupportedProtocol } from './errors.ts';

/** Gives the value of a secret of an agent's, or undefined when none is set by that name. */
export type SecretSource = (
  agent: AgentId,
  name: string,
) => Promise<string | undefined> | string | undefined;

type Loaded = {
  readonly entry: BundleEntry;
  readonly definition: AgentDefinition;
  readonly agent: Bundle['agent'];
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class InProcessExecutor implements Executor {
  readonly #secrets: SecretSource;
  readonly #loaded = new Map<DeploymentId, Loaded>();

  constructor(options: { readonly secrets?: SecretSource } = {}) {
    this.#secrets = options.secrets ?? (() => undefined);
  }

  /**
   * Loads the code of a deployment, and gives what it says it is. Rejects with a
   * `BundleError` when it is not an agent, and says why.
   */
  async load(deployment: DeploymentId, bundle: Bundle): Promise<AgentDefinition> {
    // Each deployment is a module of its own, though its code be another's to the letter:
    // what one keeps between calls is not the other's.
    const code = `${bundle.code}\n/* ${deployment} */\n`;
    const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    let exported: unknown;
    try {
      exported = ((await import(url)) as { default?: unknown }).default;
    } catch (error) {
      throw new BundleError(`The code does not load: ${messageOf(error)}`, { cause: error });
    }
    const entry =
      typeof exported === 'object' && exported !== null
        ? (exported as { [key: symbol]: BundleEntry | undefined })[Symbol.for(BUNDLE_ENTRY)]
        : undefined;
    if (
      entry === undefined ||
      typeof entry.describe !== 'function' ||
      typeof entry.call !== 'function'
    ) {
      throw new BundleError(
        'The code exports no agent: its default export is to be `new Agent(…)`',
      );
    }
    if (!supportsBundleProtocol(entry.protocol)) {
      throw new UnsupportedProtocol(entry.protocol, SUPPORTED_BUNDLE_PROTOCOLS);
    }
    let definition: AgentDefinition;
    try {
      definition = agentDefinitionSchema.parse(entry.describe());
    } catch (error) {
      throw new BundleError(messageOf(error), { cause: error });
    }
    this.#loaded.set(deployment, { entry, definition, agent: bundle.agent });
    return structuredClone(definition);
  }

  /** Forgets a deployment. Its code stays in the process's memory: a module cannot be unloaded. */
  unload(deployment: DeploymentId): void {
    this.#loaded.delete(deployment);
  }

  #get(deployment: DeploymentId): Loaded {
    const loaded = this.#loaded.get(deployment);
    if (loaded === undefined) throw new Error(`The deployment ${deployment} is not loaded`);
    return loaded;
  }

  async call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult> {
    const { entry, agent } = this.#get(deployment);
    const stopped: CallResult = {
      ok: false,
      kind: 'error',
      error: { name: 'AbortError', message: 'The call was stopped' },
    };
    if (signal.aborted) return stopped;

    const called = entry
      .call(
        path,
        structuredClone(argument),
        { ...context, agentName: agent.name },
        { secret: async (name) => this.#secrets(agent.id, name) },
      )
      // What comes back is the code's own: the engine is given a copy that is JSON.
      .then((outcome): CallResult => structuredClone(outcome))
      .catch((error: unknown): CallResult => ({
        ok: false,
        kind: 'error',
        error: { name: error instanceof Error ? error.name : 'Error', message: messageOf(error) },
      }));
    return new Promise<CallResult>((resolve) => {
      const stop = () => {
        resolve(stopped);
      };
      signal.addEventListener('abort', stop, { once: true });
      void called.then((outcome) => {
        signal.removeEventListener('abort', stop);
        resolve(outcome);
      });
    });
  }
}
