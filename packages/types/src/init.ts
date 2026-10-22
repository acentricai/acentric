// Layer 2: init. Creates an agent's first state.
//
// Called once, when the agent is created. Pure, like step. It does not
// return effects: the runner calls `effects` on the first state, as it does
// after every step.
//
// If it fails the way a step can, by throwing, returning something that is
// not Json or going over a runner limit, the agent is not created and the
// creator receives the error, as with a rejection.

import type { JsonObject } from './json.js';
import type { Rejection } from './rejection.js';
import type { LogAppend } from './state.js';

/**
 * What init returns: either the first state, or a rejection, such as for an
 * invalid config. On a rejection the agent is not created and the creator
 * receives `error`.
 */
export type InitResult<S extends JsonObject> =
  | {
      /** The agent's first snapshot. */
      snapshot: S;
      /** The first log entries, such as a record of the agent's creation. */
      append?: LogAppend[];
    }
  | Rejection;

/**
 * S is the agent's snapshot type, C its config type. `now` is the current
 * time, so a first state can hold times such as a deadline.
 */
export type Init<S extends JsonObject, C extends JsonObject> = (
  config: C,
  now: number,
) => InitResult<S>;
