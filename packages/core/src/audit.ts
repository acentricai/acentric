// The audit log: a record of what was done to the engine, and by whom. Signing in, and every
// change to people, keys, agents, their versions and their secrets. Never a secret's value, a
// password or a key. What actors say and are sent is not here: that is kept with each actor.
//
// The log is added to and never changed.

import type { AuditEvent, JsonObject, PrincipalRef } from '@acentric/protocol';

import { IdSource } from './ids.ts';
import type { PageOf, Paged, Store } from './store.ts';

/** Something that was done, to be written down. */
export type Done = {
  readonly by: PrincipalRef;
  /** What was done, as `<thing>.<what>`, such as `key.create`. */
  readonly action: string;
  /** What it was done to. */
  readonly target?: { readonly type: string; readonly id: string };
  /** What else there is to say of it. Never a secret. */
  readonly detail?: JsonObject;
};

export class Audit {
  readonly #store: Store;
  readonly #clock: () => number;
  readonly #ids: IdSource;
  readonly #report: (error: unknown) => void;

  constructor(options: {
    readonly store: Store;
    readonly clock?: () => number;
    readonly entropy?: () => Uint8Array;
    /** Told when something could not be written down. `console.error` without it. */
    readonly report?: (error: unknown) => void;
  }) {
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#ids = new IdSource(options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10))));
    this.#report =
      options.report ??
      ((error) => {
        console.error('The audit log could not be written to:', error);
      });
  }

  /**
   * Writes down what was done. It is called once the thing is done, and never fails it: a
   * log that cannot be written to is told to whoever runs the server.
   */
  async record(done: Done): Promise<void> {
    const at = this.#clock();
    const event: AuditEvent = {
      id: this.#ids.make('auditEvent', at),
      at,
      by: done.by,
      action: done.action,
      target: done.target ?? null,
      detail: done.detail ?? null,
    };
    try {
      await this.#store.addAuditEvent(event);
    } catch (error) {
      this.#report(error);
    }
  }

  /** What was done, newest first: all of it, or what was done of one kind. */
  list(query?: PageOf & { readonly action?: string }): Promise<Paged<AuditEvent>> {
    return this.#store.listAuditEvents(query);
  }
}
