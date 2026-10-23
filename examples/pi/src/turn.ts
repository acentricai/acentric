// A builder for one step's result: a working copy of the snapshot, the
// entries appended so far, and the log as the step sees it including them.

import type { LogAppend, LogEntry, State, StepResult } from '@acentric/types';

import type { PiConfig } from './config.js';
import { entryAt } from './entries.js';
import type { Entry } from './entries.js';
import type { PiLog, PiLogKind } from './log.js';
import type { PiSnapshot } from './snapshot.js';

export class Turn {
  readonly state: State<PiSnapshot, PiConfig>;
  readonly now: number;
  /** The snapshot this step returns. Assign fields; never change what they held before. */
  readonly snap: PiSnapshot;
  readonly #appends: LogAppend[] = [];
  readonly #appended: LogEntry[] = [];

  constructor(state: State<PiSnapshot, PiConfig>, now: number) {
    this.state = state;
    this.now = now;
    this.snap = { ...state.snapshot };
  }

  /** The seq the next appended entry will get. */
  get nextSeq(): number {
    return this.state.log.next + this.#appends.length;
  }

  /** Appends an entry and returns its seq. */
  append<K extends PiLogKind>(kind: K, body: PiLog[K]): number {
    const seq = this.nextSeq;
    this.#appends.push({ kind, body });
    this.#appended.push({ seq, at: this.now, kind, body });
    return seq;
  }

  /** A new effect key, such as 'llm:7'. */
  key(prefix: string): string {
    const key = `${prefix}:${this.snap.nextKey}`;
    this.snap.nextKey += 1;
    return key;
  }

  /** The log window followed by what this step appended. */
  entries(): LogEntry[] {
    return [...this.state.log.entries, ...this.#appended];
  }

  /** The entries the model sees: from the latest compaction's first kept entry. */
  contextEntries(): LogEntry[] {
    const from = this.snap.compaction?.firstKeptSeq ?? 1;
    return this.entries().filter((entry) => entry.seq >= from);
  }

  entry<K extends PiLogKind>(seq: number, kind: K): Entry<K> | null {
    return entryAt(this.entries(), seq, kind);
  }

  /** The latest compaction's summary, or null if there has been none. */
  summary(): string | null {
    const compaction = this.snap.compaction;
    return compaction === null
      ? null
      : (this.entry(compaction.seq, 'compaction')?.body.summary ?? null);
  }

  result(): StepResult<PiSnapshot> {
    return this.#appends.length === 0
      ? { snapshot: this.snap }
      : { snapshot: this.snap, append: this.#appends };
  }
}
