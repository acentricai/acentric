// Layer 1: state. Everything the agent knows when it handles a message.
//
// It has three parts with different owners:
//   - snapshot: the agent's current memory, replaced by every step.
//   - log: the agent's history, only ever appended to. A step sees only
//     the window of it the agent asked for with `window`, since a long
//     history would be slow to load for every step.
//   - config: settings owned by whoever created the agent. Only a `config`
//     message or an upgrade's migrate changes it, never a step.
//
// State is readonly. A step never changes the state it is given; it returns
// what should change, and the runner applies it. Mutating in place would
// let a failed step leave half its changes behind, so a retry would apply
// them twice.

import type { Json, JsonObject } from './json.js';

/** One record of the agent's history, as stored by the runner. */
export type LogEntry = {
  /** Position in the log: 1, 2, 3... Assigned by the runner. */
  readonly seq: number;
  /** When it was added: the `now` of the step that added it. */
  readonly at: number;
  /** The agent's own label, such as 'user_said' or 'reply'. */
  readonly kind: string;
  readonly body: Json;
};

/** A log record as the agent writes it. The runner adds `seq` and `at`. */
export type LogAppend = {
  readonly kind: string;
  readonly body: Json;
};

/**
 * The part of the log loaded for a step: every entry from `start` up to the
 * newest. `next` is known even when `entries` is empty, so a step can tell
 * which seq its own appends will receive, for example to make a summary it
 * appends the start of its next window.
 */
export type LogWindow = {
  /** The first seq in `entries`: what `window` last returned. Equals `next` when empty. */
  readonly start: number;
  /** The seq the next appended entry will receive. */
  readonly next: number;
  /** Every entry from `start` to `next - 1`, oldest first. */
  readonly entries: readonly LogEntry[];
};

/** What a step sees. S is the agent's snapshot type, C its config type. */
export type State<S extends JsonObject, C extends JsonObject> = {
  readonly snapshot: S;
  readonly log: LogWindow;
  readonly config: C;
};
