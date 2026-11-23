// What the engine keeps of an actor, and what one step of a turn writes.
//
// The state says what is owed next: a call of the model, or the results of tool calls. Whoever
// has the actor, the process that stored the state or another after a restart, reads what is
// owed and does it. So there is one way of going on, and no other for coming back.

import type { ToolCall } from '@acentric/ai';

import type { UsageRecord } from './usage.ts';
import type {
  Actor,
  ActorStatus,
  Compaction,
  ConversationEntry,
  DeploymentRef,
  InputId,
  Json,
  Message,
  Name,
  Reasoning,
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
  /**
   * Its configuration as it was given, before its agent's schema made anything of it. A move
   * to another version of its agent checks this by that version's schema. Null for none.
   */
  readonly configurationGiven: Json | null;
  /**
   * What names the instructions and tools of the last call its model answered: when a call
   * is to be made with others, they have changed. Null until its model has answered.
   */
  readonly sent: string | null;
  /**
   * The model's reasoning from before this place in the conversation is not sent to it. 1
   * when all of it is sent. It only ever moves on: reasoning that was left out stays out.
   */
  readonly reasoningFrom: number;
  /**
   * The reasoning level its calls are sent with, where that is not the level it is at: its
   * level was changed by a message in its conversation, so that the call's own stays what the
   * conversation started with. Null when its calls are sent with its own level.
   */
  readonly reasoningSent: Reasoning | null;
};

/** What of an actor a step changes besides its turn. A field that is absent stays as it is. */
export type ActorPatch = {
  readonly name?: Name | null;
  readonly modelId?: string;
  readonly reasoning?: Reasoning;
  readonly configuration?: Json | null;
  readonly configurationGiven?: Json | null;
  readonly reasoningSent?: Reasoning | null;
  readonly deployment?: DeploymentRef;
  readonly pinned?: boolean;
  readonly behind?: Actor['behind'];
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
  /** What of the actor itself changes. Null for nothing. */
  readonly set: ActorPatch | null;
  /**
   * For a call its model answered: what names the instructions and tools it was made with,
   * and the place its reasoning was sent from. Null for a step that made no such call.
   */
  readonly sent: { readonly fingerprint: string | null; readonly reasoningFrom: number } | null;
  /** For a step that ends a call of the model, answered or failed: what the call used. */
  readonly usage: UsageRecord | null;
  /** For a step that compacts the conversation: what the model is sent from then on. */
  readonly compaction?: StoredCompaction;
};

/** A compaction as it is kept: what it was, and what stands for the older part. */
export type StoredCompaction = Compaction & {
  /** The messages the model is sent in place of everything before `keepFromSeq`. */
  readonly replacement: readonly Message[];
};

/** An actor with `patch` applied. */
export function patched(actor: Actor, patch: ActorPatch | null): Actor {
  if (patch === null) return actor;
  // Kept beside the actor, not in it.
  const { configurationGiven: _given, reasoningSent: _sent, ...fields } = patch;
  return { ...actor, ...fields };
}

/** The record after `change`, with `pendingInputs` waiting in the mailbox. */
export function applyChange(
  record: ActorRecord,
  change: Change,
  pendingInputs: number,
): ActorRecord {
  return {
    actor: {
      ...patched(record.actor, change.set),
      status: change.status,
      lastTurn: change.lastTurn,
      archivedAt: change.archivedAt,
      pendingInputs,
    },
    turn: change.turn,
    epoch: record.epoch + 1,
    nextSeq: record.nextSeq + change.append.length,
    configurationGiven:
      change.set?.configurationGiven === undefined
        ? record.configurationGiven
        : change.set.configurationGiven,
    reasoningSent:
      change.set?.reasoningSent === undefined ? record.reasoningSent : change.set.reasoningSent,
    sent: change.sent === null ? record.sent : change.sent.fingerprint,
    reasoningFrom: change.sent === null ? record.reasoningFrom : change.sent.reasoningFrom,
  };
}
