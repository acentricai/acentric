// A store in memory. It is the store of tests, and of an engine that is to forget everything
// when it stops. Two engines given the same one are two processes on one database.

import type { Actor, ActorId, ConversationEntry, Input, InputId } from '@acentric/protocol';

import type { ActorRecord, Change, Turn } from './state.ts';
import { NameTaken, StaleEpoch } from './store.ts';
import type { Store } from './store.ts';

type Kept = { actor: Actor; turn: Turn; epoch: number; nextSeq: number };

/** A copy that shares nothing with what it was made from, as what a database gives back does. */
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  readonly #actors = new Map<ActorId, Kept>();
  readonly #inputs = new Map<ActorId, Input[]>();
  readonly #entries = new Map<ActorId, ConversationEntry[]>();
  /** How many commits were stored, over every actor. */
  commits = 0;

  #pending(actor: ActorId): Input[] {
    return (this.#inputs.get(actor) ?? []).filter((input) => input.deliveredAt === null);
  }

  #record(kept: Kept): ActorRecord {
    const pendingInputs = this.#pending(kept.actor.id).length;
    return copy({ ...kept, actor: { ...kept.actor, pendingInputs } });
  }

  async createActor(actor: Actor): Promise<{ record: ActorRecord; created: boolean }> {
    const siblings = [...this.#actors.values()].filter((kept) => kept.actor.agent === actor.agent);
    if (actor.externalId !== null) {
      const there = siblings.find((kept) => kept.actor.externalId === actor.externalId);
      if (there !== undefined) return { record: this.#record(there), created: false };
    }
    if (actor.name !== null && siblings.some((kept) => kept.actor.name === actor.name)) {
      throw new NameTaken(actor.name);
    }
    const kept: Kept = { actor: copy(actor), turn: { phase: 'idle' }, epoch: 0, nextSeq: 1 };
    this.#actors.set(actor.id, kept);
    return { record: this.#record(kept), created: true };
  }

  async loadActor(id: ActorId): Promise<ActorRecord | undefined> {
    const kept = this.#actors.get(id);
    return kept === undefined ? undefined : this.#record(kept);
  }

  async commit(id: ActorId, epoch: number, change: Change): Promise<void> {
    const kept = this.#actors.get(id);
    if (kept === undefined) throw new Error(`There is no actor ${id}`);
    if (kept.epoch !== epoch) throw new StaleEpoch(id, epoch, kept.epoch);

    kept.actor = {
      ...kept.actor,
      status: change.status,
      lastTurn: copy(change.lastTurn),
      archivedAt: change.archivedAt,
    };
    kept.turn = copy(change.turn);
    kept.epoch += 1;
    kept.nextSeq += change.append.length;
    const entries = [...(this.#entries.get(id) ?? []), ...copy(change.append)];
    const { leaveOutFrom } = change;
    this.#entries.set(
      id,
      leaveOutFrom === null
        ? entries
        : entries.map((entry) => (entry.seq >= leaveOutFrom ? { ...entry, leftOut: true } : entry)),
    );
    for (const input of this.#inputs.get(id) ?? []) {
      if (change.deliver.includes(input.id)) input.deliveredAt = change.at;
    }
    this.commits += 1;
  }

  async addInput(input: Input): Promise<'accepted' | 'duplicate'> {
    const inputs = this.#inputs.get(input.actor) ?? [];
    const known =
      input.externalId !== null && inputs.some((other) => other.externalId === input.externalId);
    if (known) return 'duplicate';
    this.#inputs.set(input.actor, [...inputs, copy(input)]);
    return 'accepted';
  }

  async findInput(actor: ActorId, externalId: string): Promise<InputId | undefined> {
    return (this.#inputs.get(actor) ?? []).find((input) => input.externalId === externalId)?.id;
  }

  async pendingInputs(actor: ActorId): Promise<Input[]> {
    return copy(this.#pending(actor));
  }

  async conversation(
    actor: ActorId,
    part: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<ConversationEntry[]> {
    const after = (this.#entries.get(actor) ?? []).filter((entry) => entry.seq > (part.after ?? 0));
    return copy(part.limit === undefined ? after : after.slice(0, part.limit));
  }

  async unfinished(): Promise<ActorId[]> {
    return [...this.#actors.values()]
      .filter((kept) => kept.turn.phase !== 'idle' || this.#pending(kept.actor.id).length > 0)
      .map((kept) => kept.actor.id);
  }

  async close(): Promise<void> {}
}
