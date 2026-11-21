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
  Reasoning,
  StopReason,
  Usage,
} from '@acentric/protocol';

/** A call of a tool the model made, as the engine runs it. */
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Json;
};

/** What one call of the model is given. */
export type ModelStep = {
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly instructions: string;
  readonly tools: readonly FunctionTool[];
  readonly messages: readonly Message[];
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

/** Why a call of a model failed, as far as what to do about it goes. */
export type FailureKind =
  /** Too many calls: the same call may work later. */
  | 'rate_limited'
  /** The provider cannot take the call now. */
  | 'overloaded'
  /** The call did not reach the provider, or its answer did not come back. */
  | 'network'
  /** The credential was refused. */
  | 'auth'
  /** The provider refused the call as it is: the same call will be refused again. */
  | 'invalid_request'
  | 'other';

const RETRYABLE: readonly FailureKind[] = ['rate_limited', 'overloaded', 'network'];

/** A call of a model failed. */
export class ModelFailure extends Error {
  override readonly name = 'ModelFailure';
  readonly kind: FailureKind;
  /** How long the provider said to wait before the call is made again, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, kind: FailureKind, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }

  /** Whether the same call, made again later, may work. */
  get retryable(): boolean {
    return RETRYABLE.includes(this.kind);
  }
}
