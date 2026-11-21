// Giving each actor the runner of its agent's provider.

import type { Credential, ModelRunner, Providers } from '@acentric/ai';

import type { RunnerSource } from './engine.ts';

/**
 * A source of runners from the providers an engine has. `credentialOf` gives what a provider's
 * calls are made with. A provider's runner is made the first time it is needed, and kept: the
 * credential is asked for once for each provider.
 *
 * An agent of a provider the engine has not, or one with no credential, has no runner: the
 * call fails, and the turn with it, with what is missing said.
 */
export function providerRunners(
  providers: Providers,
  credentialOf: (provider: string) => Credential | undefined,
): RunnerSource {
  const runners = new Map<string, ModelRunner>();
  return (_actor, definition) => {
    const id = definition.provider;
    let runner = runners.get(id);
    if (runner === undefined) {
      const provider = providers.get(id);
      const credential = credentialOf(id);
      if (credential === undefined) {
        throw new Error(`There is no account for ${provider.label}: its calls cannot be made`);
      }
      runner = provider.runner({ credential });
      runners.set(id, runner);
    }
    return runner;
  };
}
