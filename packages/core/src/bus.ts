// How whoever follows an actor is told what happened to it. Nothing is kept: one who was not
// listening reads the conversation from the store, and listens from there.

import type { ActorEvent, ActorId } from '@acentric/protocol';

export interface EventBus {
  publish(actor: ActorId, event: ActorEvent): void;
  /** Returns what stops the listening. */
  subscribe(actor: ActorId, listener: (event: ActorEvent) => void): () => void;
}

/** A bus within one process. */
export class MemoryBus implements EventBus {
  readonly #listeners = new Map<ActorId, Set<(event: ActorEvent) => void>>();

  publish(actor: ActorId, event: ActorEvent): void {
    for (const listener of this.#listeners.get(actor) ?? []) listener(event);
  }

  subscribe(actor: ActorId, listener: (event: ActorEvent) => void): () => void {
    const listeners = this.#listeners.get(actor) ?? new Set();
    this.#listeners.set(actor, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(actor);
    };
  }
}
