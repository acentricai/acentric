// The pi agent's snapshot: step's working memory.
//
// It is rewritten on every step, so it holds only control state, settings
// and small indexes into the log, never content: messages, queued messages
// and summaries live in the log. Its indexes are updated in the same step
// that appends what they point at.
//
// A step sees the log from the latest compaction's first kept entry, or
// from the oldest queued message if that is older, so step can still read a
// queued message when its turn comes.

import type { ModelRef, ThinkingLevel } from './content.js';
import type { Settings } from './config.js';

/** One tool call from the current reply, and how far it has got. */
export type ToolCallState = {
  toolCallId: string;
  toolName: string;
  /**
   * - waiting: not started, such as an edit waiting for an earlier edit to
   *   the same file
   * - running: its effect is declared, under `key`
   * - done: its result is in the log
   */
  status: 'waiting' | 'running' | 'done';
  key: string | null;
  /** The file an edit or write changes, resolved against the working directory; null for other tools. */
  path: string | null;
};

/**
 * A run being stopped, and what follows once everything stopped has
 * reported: nothing, or a manual compaction.
 */
export type Aborting = { next: 'idle' } | { next: 'compact'; instructions: string | null };

/** Where the run is. */
export type Phase =
  /** No run going. */
  | { kind: 'idle' }
  /**
   * A model call is running with this model and thinking level. `toSeq`
   * ends the conversation it was given.
   */
  | {
      kind: 'calling_llm';
      key: string;
      model: ModelRef;
      thinkingLevel: ThinkingLevel;
      toSeq: number;
      aborting: Aborting | null;
    }
  /** The tool calls of the reply at `assistantSeq` are running. */
  | {
      kind: 'running_tools';
      assistantSeq: number;
      calls: ToolCallState[];
      aborting: Aborting | null;
    }
  /** Waiting until `at` to retry a failed model call. */
  | { kind: 'waiting_retry'; key: string; at: number }
  /**
   * Summarising the entries before `firstKeptSeq`. `tokensBefore` is the
   * context size when it started; `thenContinue` resumes the run afterwards.
   */
  | {
      kind: 'compacting';
      key: string;
      reason: 'manual' | 'threshold' | 'overflow';
      firstKeptSeq: number;
      tokensBefore: number;
      instructions: string | null;
      thenContinue: boolean;
    };

export type PiSnapshot = {
  settings: Settings;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  phase: Phase;
  /** The `queued` entries of steer messages waiting, oldest first. */
  steering: number[];
  /** The `queued` entries of follow-up messages waiting, oldest first. */
  followUps: number[];
  /** Failed model calls in a row, for retry backoff. */
  retries: number;
  /** Whether a context overflow was already compacted for the current prompt; it is tried once. */
  overflowRecovered: boolean;
  /** The latest compaction entry, and the first entry it keeps. */
  compaction: { seq: number; firstKeptSeq: number } | null;
  /** Counts up to make effect keys unique, such as 'llm:7'. */
  nextKey: number;
};
