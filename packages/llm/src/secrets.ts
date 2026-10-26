// The secrets the client reads, by name. Runners and the CLI import these
// names to pass the matching environment variables to handlers, so no
// runner names a provider itself.
//
// The client calls the gateway when both gateway secrets are set, and a
// provider directly with its key otherwise. A provider key set alongside the
// gateway's travels as the call's credentials, so the gateway uses it instead
// of its own. A secret that is not set rejects with SecretNotSet on every
// runner (RUNNERS.md §8), which is how the client tells which are set.

import type { Provider } from './providers.js';

/** The secret holding each provider's API key. */
export const PROVIDER_SECRETS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
} as const satisfies { readonly [P in Provider]: string };

/** The gateway's address and token, which acentric-cloud sets for every release. */
export const GATEWAY_SECRETS = {
  url: 'ACENTRIC_LLM_URL',
  token: 'ACENTRIC_LLM_TOKEN',
} as const;

/**
 * The secrets the client reads, taken from an environment where they are set:
 * what a runner on your own machine passes to handlers, such as
 * `createMemoryRunner({ secrets: llmSecrets(process.env) })`.
 */
export function llmSecrets(env: { readonly [name: string]: string | undefined }): {
  [name: string]: string;
} {
  const names = [...Object.values(PROVIDER_SECRETS), ...Object.values(GATEWAY_SECRETS)];
  const found: { [name: string]: string } = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') found[name] = value;
  }
  return found;
}
