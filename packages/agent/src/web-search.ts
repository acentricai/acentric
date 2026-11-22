// The provider's own web search: the model searches, and the provider runs the search and
// gives the model what it found.

import type { Provider } from './models.ts';

/** Which sites a search looks at: only these, or any but these. A domain is such as `example.com`. */
export type WebSearchOptions =
  | { readonly allowedDomains: readonly string[]; readonly blockedDomains?: never }
  | { readonly blockedDomains: readonly string[]; readonly allowedDomains?: never };

/** What each provider that has a search takes for it. Another module may add a provider's. */
export interface ProviderWebSearch {
  openai: true | WebSearchOptions;
  chatgpt: true | WebSearchOptions;
  anthropic: true | WebSearchOptions;
}

/**
 * What an agent on provider `P` takes for `webSearch`. A provider that is known to have none
 * takes nothing. One the framework does not know is taken at its word, and the engine says
 * at the deploy whether it has a search.
 */
export type WebSearch<P extends Provider = Provider> = P extends keyof ProviderWebSearch
  ? ProviderWebSearch[P]
  : P extends 'fireworks'
    ? never
    : true | WebSearchOptions;
