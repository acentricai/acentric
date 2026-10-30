// The working copy of one step. Step opens one from the state it is given;
// every procedure changes it, replacing the snapshot, appending entries and
// taking effect keys; step returns what it holds. The state it was opened
// from is never changed, so a step that throws leaves nothing behind.

import type { LogAppend, LogEntry, State, StepResult } from '@acentric/types';

import type { Config } from '../types/config.js';
import { log } from '../types/log.js';
import type { LogBodies, LogKind } from '../types/log.js';
import type { Settings } from '../types/settings.js';
import type { Snapshot } from '../types/snapshot.js';

export type Draft = {
  readonly now: number;
  readonly settings: Settings;
  snapshot: Snapshot;
  /** The window's entries, then those appended this step with the seqs they will get. */
  readonly entries: LogEntry[];
  /** What this step appends. */
  readonly appended: LogAppend[];
  /** The seq the step's first appended entry gets. */
  readonly next: number;
};

export function openDraft(state: State<Snapshot, Config>, settings: Settings, now: number): Draft {
  return {
    now,
    settings,
    snapshot: state.snapshot,
    entries: [...state.log.entries],
    appended: [],
    next: state.log.next,
  };
}

export function closeDraft(d: Draft): StepResult<Snapshot> {
  return { snapshot: d.snapshot, append: d.appended };
}

/** Replaces some of the snapshot's fields. */
export function update(d: Draft, fields: Partial<Snapshot>): void {
  d.snapshot = { ...d.snapshot, ...fields };
}

/** The seq the next appended entry will get. */
export function nextSeq(d: Draft): number {
  return d.next + d.appended.length;
}

/** Appends an entry, its body checked against its kind, and returns the seq it will get. */
export function append<K extends LogKind>(d: Draft, kind: K, body: LogBodies[K]): number {
  return appendEntry(d, log.append(kind, body));
}

/** Appends an entry a part made, and returns the seq it will get. */
export function appendEntry(d: Draft, entry: LogAppend): number {
  const seq = nextSeq(d);
  d.appended.push(entry);
  d.entries.push({ seq, at: d.now, kind: entry.kind, body: entry.body });
  return seq;
}

/** A new effect key, such as llm:7: one counter for every key, so none is used twice. */
export function newKey(d: Draft, prefix: string): string {
  const n = d.snapshot.nextKey;
  update(d, { nextKey: n + 1 });
  return `${prefix}:${n}`;
}
