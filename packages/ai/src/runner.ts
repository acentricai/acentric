// What the engine asks of a model: one call, and one whole answer. Nothing is given of an
// answer while the model writes it. A provider that only answers a request it streams reads
// the stream itself, to its end, and gives the whole.
//
// The answer's message is the provider's own output, which only the provider can read. So the
// runner reads out of it what the engine acts on: the tool calls.

import type {
  AssistantMessage,
  FunctionTool,
  Json,
  Message,
  ProviderFields,
  Reasoning,
  StopReason,
  Usage,
} from '@acentric/protocol';

/** A call of a tool the model made, as the engine runs it. */
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  /** What the model called it with: JSON as it read, or the text itself when it does not read. */
  readonly arguments: Json;
  /** What the provider needs said again on the result of this call. */
  readonly resultOptions?: ProviderFields;
};

/** What one call of the model is given. */
export type ModelStep = {
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly instructions: string;
  readonly tools: readonly FunctionTool[];
  readonly messages: readonly Message[];
  /**
   * What names the conversation to the provider, the same at every call of it: a provider that
   * keeps what it has read of a conversation finds it again by this.
   */
  readonly session?: string;
  /** What the agent asks of its provider that only that provider has, as the provider read it. */
  readonly options?: ProviderFields;
  /**
   * Asks the provider to compact what it is sent, in place of answering: its answer is what
   * stands for the conversation from then on. Only for a provider that `compacts`.
   */
  readonly compact?: true;
};

/** What one call of the model came to. */
export type ModelAnswer = {
  readonly message: AssistantMessage;
  readonly stopReason: StopReason;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: Usage;
};

export interface ModelRunner {
  /**
   * Calls the model once. Rejects with a `ModelFailure` when the call failed, and as soon as
   * it can when `signal` is aborted.
   */
  run(step: ModelStep, signal: AbortSignal): Promise<ModelAnswer>;
}
