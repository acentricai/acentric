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
  readonly #report: (error: unknown) => void;

  constructor(options: { readonly report?: (error: unknown) => void } = {}) {
    this.#report = options.report ?? (() => {});
  }

  /**
   * Tells every listener. One that fails is its own failure: the others are told all the same,
   * and what published, an actor's turn that has stored what it tells, goes on.
   */
  publish(actor: ActorId, event: ActorEvent): void {
    // As they are now: one may stop listening while it is told.
    for (const listener of [...(this.#listeners.get(actor) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.#report(error);
      }
    }
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
