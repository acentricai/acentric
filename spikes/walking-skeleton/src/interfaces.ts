// THROWAWAY. A first guess at the interfaces the engine's core is built on, written to see
// whether they fit together before the real core is designed. Nothing here is a decision.
//
// The parts: a store that keeps an actor, a runner that calls a model, an executor that runs
// an agent's code, and a bus that tells whoever follows an actor what happened.

import type {
  Actor,
  ActorEvent,
  ActorId,
  ActorStatus,
  AgentDefinition,
  AgentId,
  AssistantMessage,
  ConversationEntry,
  DeploymentId,
  FunctionTool,
  Input,
  InputId,
  Json,
  Message,
  Reasoning,
  StopReason,
  ToolResultMessage,
  TurnEnd,
  Usage,
} from '@acentric/protocol';

/** The time, in milliseconds. */
export type Clock = () => number;

/** Ten random bytes. */
export type Entropy = () => Uint8Array;

// The model

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

/**
 * What one call of the model came to: one whole answer. The message is the provider's own, and
 * only the provider can read it, so the runner reads out of it what the engine acts on: the
 * tool calls.
 */
export type ModelAnswer = {
  readonly message: AssistantMessage;
  readonly stopReason: StopReason;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: Usage;
};

export interface ModelRunner {
  /** Calls the model once. Rejects when the call failed. */
  run(step: ModelStep): Promise<ModelAnswer>;
}

// An agent's code

export type CallContext = {
  readonly agent: AgentId;
  readonly actor: ActorId;
  readonly configuration: Json | null;
};

/** How a call of an agent's function ended: with what it returned, or with why it did not. */
export type CallResult =
  { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly error: string };

export interface Executor {
  /** What the deployment's code says of itself. */
  describe(deployment: DeploymentId): Promise<AgentDefinition>;
  /** Calls a function of the deployment's code by its path, such as `tools.lookup_order.execute`. */
  call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
  ): Promise<CallResult>;
}

// Events

export interface EventBus {
  publish(actor: ActorId, event: ActorEvent): void;
  /** Returns what stops the listening. */
  subscribe(actor: ActorId, listener: (event: ActorEvent) => void): () => void;
}

// The store

/** A tool call the turn owes an answer for. Its result is null until the tool has answered. */
export type OwedCall = ToolCall & { readonly result: ToolResultMessage | null };

/**
 * Where an actor's turn stands. It says what is owed next, so that whoever picks the actor up,
 * the same process or another after a restart, does the same thing.
 */
export type Turn =
  /** No turn. One starts when there is something in the mailbox. */
  | { readonly phase: 'idle' }
  /** A call of the model is owed. */
  | { readonly phase: 'model' }
  /** The model called tools, and their results are owed. */
  | { readonly phase: 'tools'; readonly calls: readonly OwedCall[] };

/** An actor as the store keeps it. */
export type ActorRecord = {
  /** `pendingInputs` is counted by the store when the actor is read: nothing else sets it. */
  readonly actor: Actor;
  readonly turn: Turn;
  /** Counts the commits. A commit names the epoch it read, and is refused when that has passed. */
  readonly epoch: number;
  /** The place of the conversation's next message. */
  readonly nextSeq: number;
};

/** Everything one step of a turn writes. It is stored whole, or not at all. */
export type Change = {
  readonly at: number;
  readonly status: ActorStatus;
  readonly lastTurn: TurnEnd | null;
  readonly turn: Turn;
  /** Messages added to the conversation, in order. */
  readonly append: readonly ConversationEntry[];
  /** Inputs taken out of the mailbox: they are among the messages added. */
  readonly deliver: readonly InputId[];
};

/** A commit named an epoch that has passed: something else has written to the actor since. */
export class StaleEpoch extends Error {
  override readonly name = 'StaleEpoch';
  constructor(actor: ActorId, read: number, now: number) {
    super(`${actor} was read at epoch ${String(read)} and is at ${String(now)}`);
  }
}

export interface Store {
  createActor(actor: Actor): Promise<ActorRecord>;
  loadActor(id: ActorId): Promise<ActorRecord | undefined>;
  /** Stores `change`, if the actor is still at `epoch`. Rejects with `StaleEpoch` when it is not. */
  commit(id: ActorId, epoch: number, change: Change): Promise<ActorRecord>;
  /**
   * Puts an input in the mailbox. It does not name an epoch: an input may arrive at any time,
   * a turn or none going on. `duplicate` when the actor has one of its external ID already.
   */
  addInput(input: Input): Promise<'accepted' | 'duplicate'>;
  /** What waits in the mailbox, oldest first. */
  pendingInputs(actor: ActorId): Promise<Input[]>;
  conversation(actor: ActorId): Promise<ConversationEntry[]>;
  /** The actors with something owed: a turn under way, or mail that waits. */
  unfinished(): Promise<ActorId[]>;
}
