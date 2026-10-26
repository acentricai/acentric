// The providers, and what each contributes to the types. A provider is called
// through one API format; the formats are the shapes the client reads and
// writes, and a provider adds its own items and options to its format's.

import type { JsonObject } from '@acentric/types';

import type { AnthropicSpec } from './providers/anthropic.js';
import type { FireworksSpec } from './providers/fireworks.js';
import type { OpenAiSpec } from './providers/openai.js';

/** An API format: one request and response shape that several providers may serve. */
export type ApiFormat = 'openai-responses' | 'anthropic-messages';

/** What a provider contributes to the types. Every entry in `Providers` satisfies it. */
export type ProviderSpec = {
  /** The API format this provider is called through. */
  readonly api: ApiFormat;
  /** What the client sends the provider to authenticate. Read from secrets, never from args. */
  readonly credentials: JsonObject;
  /** The provider's own request fields, minus the ones the request owns. */
  readonly options: JsonObject;
  /** A provider-specific input item, carried by a `native` message. */
  readonly inputItem: JsonObject;
  /** One item of the provider's output, kept as it is in an assistant message. */
  readonly outputItem: JsonObject;
  /** The provider's response fields other than its output. */
  readonly response: JsonObject;
  /** Model IDs the types know, for autocomplete. Any other ID works too. */
  readonly modelId: string;
};

/** Every provider, by ID. */
export type Providers = {
  readonly anthropic: AnthropicSpec;
  readonly openai: OpenAiSpec;
  readonly fireworks: FireworksSpec;
};

/** Fails to compile when a provider does not satisfy `ProviderSpec`. */
type Checked<T extends { readonly [P in keyof Providers]: ProviderSpec }> = T;
export type RegisteredProviders = Checked<Providers>;

export type Provider = keyof Providers;

export type ApiOf<P extends Provider> = Providers[P]['api'];
export type Credentials<P extends Provider> = Providers[P]['credentials'];
export type ProviderOptions<P extends Provider> = Providers[P]['options'];
export type NativeInputItem<P extends Provider> = Providers[P]['inputItem'];
export type NativeOutputItem<P extends Provider> = Providers[P]['outputItem'];
export type NativeResponse<P extends Provider> = Providers[P]['response'];
export type KnownModelId<P extends Provider> = Providers[P]['modelId'];

/** A model ID the types know, which autocompletes, or any other the provider serves. */
export type ModelId<P extends Provider> = KnownModelId<P> | (string & {});

/** The providers called through `api`. */
export type ProviderOf<A extends ApiFormat> = {
  [P in Provider]: ApiOf<P> extends A ? P : never;
}[Provider];
