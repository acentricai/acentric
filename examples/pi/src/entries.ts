// Typed access to the agent's own log entries.
//
// The framework stores entry bodies as Json. Every entry in this agent's log
// was appended by its own step with a body of its kind's type, so reading
// one back by kind is safe; this is the one place that relies on it.

import type { LogEntry } from '@acentric/types';

import type { PiLog, PiLogKind } from './log.js';

/** A log entry with its body typed by kind. */
export type Entry<K extends PiLogKind = PiLogKind> = {
  seq: number;
  at: number;
  kind: K;
  body: PiLog[K];
};

export function isKind<K extends PiLogKind>(entry: LogEntry, kind: K): entry is Entry<K> {
  return entry.kind === kind;
}

/** The entry at `seq` if it is in `entries` and of `kind`, else null. */
export function entryAt<K extends PiLogKind>(
  entries: readonly LogEntry[],
  seq: number,
  kind: K,
): Entry<K> | null {
  const first = entries[0];
  if (first === undefined) return null;
  const entry = entries[seq - first.seq];
  return entry !== undefined && entry.seq === seq && isKind(entry, kind) ? entry : null;
}
