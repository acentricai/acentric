// What one provider changes about the Responses format: where to send it, how
// to sign it, and what is its own. The format's adapter does the rest.

import type { JsonObject } from '@acentric/types';

import type { LlmFailureKind } from '../../failure.js';
import type { Credentials, ProviderOf } from '../../providers.js';

/** The providers called through the Responses format. */
export type ResponsesProvider = ProviderOf<'openai-responses'>;

export type ResponsesProfile<P extends ResponsesProvider> = {
  readonly provider: P;
  /** Names the provider in messages, such as "OpenAI". */
  readonly label: string;
  /** The create-response URL. */
  readonly url: string;
  /** Authentication and other headers. */
  headers(credentials: Credentials<P>): { readonly [name: string]: string };
  /** The role mid-conversation system messages are sent with. */
  readonly systemRole: 'system' | 'developer';
  /** Whether file parts work. When not, they are refused, since the provider drops them without a word. */
  readonly files: boolean;
  /** Whether images and files may be a file ID in the provider's own storage. */
  readonly fileIds: boolean;
  /** Whether custom tools work. When not, they and their results are refused. */
  readonly customTools: boolean;
  /** Response fields that only repeat the request, left out of `native`. */
  readonly echoFields: readonly string[];
  /** Fields the provider writes on output items but refuses on input, left out when sending back. */
  readonly outputOnlyFields: readonly string[];
  /**
   * What to multiply standard prices by for how the response was served, or
   * undefined when that is not known, which means no cost estimate.
   */
  priceMultiplier(native: JsonObject, options: JsonObject): number | undefined;
  /** The provider's own reading of an error the format does not recognize. */
  classifyError?(error: ErrorInput): ErrorReading | undefined;
};

/** What a profile sees of an error. */
export type ErrorInput = {
  /** Left out for a failed response that came with HTTP 200. */
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly message?: string;
};

/** What an error means, where the provider's own code does not say. */
export type ErrorReading = {
  readonly kind: LlmFailureKind;
  /** The request field at fault, when the error does not name it. */
  readonly param?: string;
};
