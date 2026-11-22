// What one provider changes about the Responses format: where a call is sent, how it is
// signed, and what is the provider's own. The format's codec does the rest.

import type { Json, JsonObject, ProviderFields, Reasoning } from '@acentric/protocol';

import type { ModelInfo } from '../catalog.ts';
import type { FailureKind } from '../failure.ts';
import type { Credential } from '../provider.ts';
import type { ModelStep } from '../runner.ts';

export type ResponsesProfile = {
  readonly id: string;
  readonly label: string;
  /** Where a response is asked for. */
  readonly url: string;
  readonly models: readonly ModelInfo[];
  /** What signs a call. */
  headers(credential: Credential): { readonly [name: string]: string };
  /** The role an instruction in the middle of a conversation is sent with. */
  readonly systemRole: 'system' | 'developer';
  /** Whether a file is read. When not, one is refused, since the provider drops it without a word. */
  readonly files: boolean;
  /** Whether an image or file may be an ID in the provider's own storage. */
  readonly fileIds: boolean;
  /** Fields the provider writes on its output and refuses when it is sent back. */
  readonly outputOnlyFields: readonly string[];
  /**
   * Whether the instructions go first in the input, as a message, in place of the
   * `instructions` field: a provider that keeps what it has read of the input, and not of
   * that field, keeps them so.
   */
  readonly instructionsInInput: boolean;
  /** Whether it answers only as a stream of events. The call then asks for one and reads it whole. */
  readonly streams: boolean;
  /** The request's own fields for a step: its reasoning, and what the provider keeps by. */
  options(step: ModelStep): JsonObject;
  /** The provider's own tools the agent asked for, as it is sent them. */
  hostedTools(options: ProviderFields): JsonObject[];
  /**
   * What to multiply standard prices by for how a response was served, or undefined when that
   * is not known: there is then no cost.
   */
  priceMultiplier(response: JsonObject): number | undefined;
  /** What one search of the provider's own web search costs, in dollars. */
  readonly searchPrice?: number;
  /** Where the provider lists its models: what a key is checked with. */
  readonly modelsUrl?: string;
  /**
   * The item that changes the reasoning level from where it is in the input, for a provider
   * that has one. Without it, the level is the request's alone.
   */
  reasoningChange?(model: string, reasoning: Reasoning): JsonObject;
  /** The provider's own reading of a failure the format does not know. */
  classify?(failure: ErrorInput): ErrorReading | undefined;
};

/** What a profile is shown of a failure. */
export type ErrorInput = {
  /** Left out for a response that failed and came with HTTP 200. */
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly message?: string;
  /** The error as the provider wrote it. */
  readonly detail?: Json;
};

export type ErrorReading = {
  readonly kind: FailureKind;
  /** What to say in place of the provider's message, when it says too little. */
  readonly message?: string;
};
