// What the memory runner keeps: every session's state, in plain objects.
//
// The store is separate from the runner. A runner can be closed abruptly
// and a new one started over the same store, which is how the runner
// recovers, and how tests stand in for a crash. Nothing outlives the
// process.

import type { EffectRequest, JsonObject, LogEntry, Mode } from '@acentric/types';

/** An effect that was declared and has not finished. */
export type StoredEffect = {
  request: EffectRequest;
  mode: Mode;
  /** Runs of this key so far, counting the current one. */
  attempt: number;
};

export type StoredSession = {
  id: string;
  agent: { name: string; version: string };
  config: JsonObject;
  snapshot: JsonObject;
  log: LogEntry[];
  /** Declared and unfinished effects, by key, in the order they started. */
  effects: Map<string, StoredEffect>;
  /** Keys that finished or were cancelled; they never run again. */
  finished: Set<string>;
  /** Set when a step the runner could not drop failed; the session then takes no messages. */
  fault: string | null;
};

export type MemoryStore = {
  sessions: Map<string, StoredSession>;
  /** Counts up to name new sessions. */
  created: number;
};

export function createMemoryStore(): MemoryStore {
  return { sessions: new Map(), created: 0 };
}
