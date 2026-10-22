// Layer 2: step. The reducer: one message in, the next state out.
//
// Called once per message. Pure: no I/O, no clock, no randomness; the
// current time arrives as `now`. A step can replace the snapshot and append
// to the log. It cannot change config (only a `config` message or migrate
// does), edit or remove log entries, or start or cancel effects (that is
// `effects`).

import type { JsonObject } from './json.js';
import type { Message } from './message.js';
import type { Rejection } from './rejection.js';
import type { Kinds } from './request.js';
import type { LogAppend, State } from './state.js';

/**
 * What step returns: the next state, or a rejection.
 *
 * A rejection is only meaningful for messages a caller sent, `input`,
 * `config`, `pause` and `resume`: the caller is told, and the state stays
 * as it was. An `effect` or `migrated` message has no caller to tell, and
 * rejecting an effect would lose its result for good, so the runner treats
 * a rejection of either as a bug, like a thrown error.
 */
export type StepResult<S extends JsonObject> =
  | {
      /** The next snapshot. Return `state.snapshot` to leave it unchanged. */
      snapshot: S;
      /** New log entries. The runner adds `seq` and `at`. */
      append?: LogAppend[];
    }
  | Rejection;

/**
 * S is the agent's snapshot type, C its config type and K its map of kinds,
 * which types the results in effect messages.
 */
export type Step<S extends JsonObject, C extends JsonObject, K extends Kinds = Kinds> = (
  state: State<S, C>,
  msg: Message<K>,
  now: number,
) => StepResult<S>;
