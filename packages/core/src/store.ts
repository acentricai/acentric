// What the engine keeps things in. A store keeps actors, their conversations and their
// mailboxes, and says which actors have something owed.
//
// Two rules are the store's to keep, whatever it is made of:
//
//   - A commit is stored whole, or not at all.
//   - A commit names the epoch of the actor it read, and is refused when the actor has been
//     written since. So of two writers that each think the actor theirs, one is stopped.

import type {
  Actor,
  ActorId,
  ConversationEntry,
  ErrorCode,
  Input,
  InputId,
} from '@acentric/protocol';

import type { ActorRecord, Change } from './state.ts';

/** A commit named an epoch that has passed: something else has written to the actor since. */
export class StaleEpoch extends Error {
  override readonly name = 'StaleEpoch';
  constructor(actor: ActorId, read: number, now: number) {
    super(`${actor} was read at epoch ${String(read)} and is at ${String(now)}`);
  }
}

/** The name is another actor's of the same agent. */
export class NameTaken extends Error {
  override readonly name = 'NameTaken';
  readonly code: ErrorCode = 'name_taken';
  constructor(name: string) {
    super(`An actor of this agent is named ${name} already`);
  }
}

export interface Store {
  /**
   * Keeps a new actor, idle and with nothing said. When it has an external ID that an actor of
   * its agent has already, that actor is given back and nothing is kept. Rejects with
   * `NameTaken` when its name is another's.
   */
  createActor(actor: Actor): Promise<{ readonly record: ActorRecord; readonly created: boolean }>;
  loadActor(id: ActorId): Promise<ActorRecord | undefined>;
  /** Stores `change`, if the actor is still at `epoch`. Rejects with `StaleEpoch` when it is not. */
  commit(id: ActorId, epoch: number, change: Change): Promise<void>;

  /**
   * Puts an input in the mailbox. It names no epoch: an input may arrive at any moment, a turn
   * going on or none. `duplicate` when the actor has one of its external ID already.
   */
  addInput(input: Input): Promise<'accepted' | 'duplicate'>;
  /** The input the actor was sent with this external ID, if it was sent one. */
  findInput(actor: ActorId, externalId: string): Promise<InputId | undefined>;
  /** What waits in the mailbox, oldest first. */
  pendingInputs(actor: ActorId): Promise<Input[]>;

  /** A part of the conversation, in order: the messages after `after`, `limit` at most. */
  conversation(
    actor: ActorId,
    part?: { readonly after?: number; readonly limit?: number },
  ): Promise<ConversationEntry[]>;

  /** The actors with something owed: a turn under way, or mail that waits. */
  unfinished(): Promise<ActorId[]>;

  close(): Promise<void>;
}
