// What the engine keeps of an actor, and what one step of a turn writes.
//
// The state says what is owed next: a call of the model, or the results of tool calls. Whoever
// has the actor, the process that stored the state or another after a restart, reads what is
// owed and does it. So there is one way of going on, and no other for coming back.

import type { ToolCall } from '@acentric/ai';
import type {
  Actor,
  ActorStatus,
  ConversationEntry,
  InputId,
  ToolResultMessage,
  TurnEnd,
} from '@acentric/protocol';

/** A tool call the turn owes an answer for. Its result is null until the tool has answered. */
export type OwedCall = ToolCall & { readonly result: ToolResultMessage | null };

/** Where an actor's turn stands. */
export type Turn =
  /** No turn. One starts when there is something in the mailbox. */
  | { readonly phase: 'idle' }
  /** A call of the model is owed. */
  | {
      readonly phase: 'model';
      /** The place in the conversation of the turn's first message. */
      readonly startSeq: number;
      /** Which try of this call it is, from 1: more than 1 after a failure that may pass. */
      readonly attempt: number;
      /** How many times a restart found this call owed. */
      readonly cutOffs: number;
      /** Not before this time: the wait after a failure. Null for at once. */
      readonly retryAt: number | null;
    }
  /** The model called tools, and their results are owed. */
  | { readonly phase: 'tools'; readonly startSeq: number; readonly calls: readonly OwedCall[] };

/** An actor as the store keeps it. */
export type ActorRecord = {
  /** `pendingInputs` is counted from the mailbox by whoever reads the actor: no step sets it. */
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
  readonly archivedAt: number | null;
  readonly turn: Turn;
  /** Messages added to the conversation, in order. */
  readonly append: readonly ConversationEntry[];
  /** Inputs taken out of the mailbox: they are among the messages added. */
  readonly deliver: readonly InputId[];
  /**
   * Messages from this place on are marked left out: they stay in the conversation, and are
   * not sent to the model again. Null for none.
   */
  readonly leaveOutFrom: number | null;
};

/** The record after `change`, with `pendingInputs` waiting in the mailbox. */
export function applyChange(
  record: ActorRecord,
  change: Change,
  pendingInputs: number,
): ActorRecord {
  return {
    actor: {
      ...record.actor,
      status: change.status,
      lastTurn: change.lastTurn,
      archivedAt: change.archivedAt,
      pendingInputs,
    },
    turn: change.turn,
    epoch: record.epoch + 1,
    nextSeq: record.nextSeq + change.append.length,
  };
}
