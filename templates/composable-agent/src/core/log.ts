// The log's shared pieces: the conversation the model sees, notices for
// UIs, and typed helpers each part uses for its own entries.
//
// Entries are written once and kept for good, and migrate cannot rewrite
// them, so every later version of the agent reads them as they were
// written. Change an entry's shape only by adding optional fields; for
// anything else, add a new kind and read both.

import type { LlmResponse, ToolResultMessage, UserMessage } from '@acentric/llm';
import type { Json, LogAppend, LogEntry } from '@acentric/types';

/** What the model sees. @acentric/llm's types are stored as they are, so they are sent back unchanged. */
export type ConversationEntries = {
  /** A user message the model sees. */
  user: UserMessage;
  /** One model reply: its message, and its stop reason, usage and cost. */
  assistant: LlmResponse;
  /** One tool call's result, appended when it finishes. */
  tool_result: ToolResultMessage;
};

/** For UIs: the session starting, a retry, a compaction that failed. Never sent to the model. */
export type NoticeEntries = {
  notice: { level: 'info' | 'warning' | 'error'; text: string };
};

/** A log entry of a map of kinds `B`, with its body typed by its kind. */
export type Entry<B, K extends keyof B = keyof B> = {
  readonly seq: number;
  readonly at: number;
  readonly kind: K;
  readonly body: B[K];
};

/**
 * Typed helpers for the entries of a map of kinds to bodies: the whole log's,
 * or one part's own. Every body must be plain JSON.
 */
export function logOf<B extends { [K in keyof B]: Json }>() {
  const helpers = {
    /** An entry to append, its body checked against its kind. */
    append: <K extends keyof B & string>(kind: K, body: B[K]): LogAppend => ({ kind, body }),

    // The runner stores bodies as Json. Every entry was appended by this
    // agent's own step with a body of its kind's type, so reading one back
    // by its kind is safe; this is the one place that relies on it.
    isKind: <K extends keyof B & string>(entry: LogEntry, kind: K): entry is Entry<B, K> =>
      entry.kind === kind,

    /** The entry at `seq` if it is in `entries` and of `kind`, else null. */
    entryAt: <K extends keyof B & string>(
      entries: readonly LogEntry[],
      seq: number,
      kind: K,
    ): Entry<B, K> | null => {
      const entry = atSeq(entries, seq);
      return entry !== null && helpers.isKind(entry, kind) ? entry : null;
    },
  };
  return helpers;
}

/** The entry at `seq` in a contiguous run of entries, such as a step's window. */
function atSeq(entries: readonly LogEntry[], seq: number): LogEntry | null {
  const first = entries[0];
  if (first === undefined) return null;
  const entry = entries[seq - first.seq];
  return entry !== undefined && entry.seq === seq ? entry : null;
}
