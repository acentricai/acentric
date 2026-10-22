// Layer 2: effects. Turns the agent's state into the list of effects that
// should exist right now.
//
// The agent keeps what is in progress in its snapshot, in whatever form it
// likes; this pure function converts that into requests the runner can
// compare. The runner calls it after init, after every accepted step and
// after a restart, and then:
//   - starts every key it is not already running,
//   - cancels every running key that is missing, with no message back,
//   - keeps running keys as they are, ignoring any change to their args,
//   - ignores keys that already finished, since keys are single-use,
//   - treats the same key twice in one list as a bug.
//
// It takes no `now`. The list must depend on the state alone, so the runner
// gets the same answer whenever it asks, including after a restart. A step
// computes any time once and stores it in the snapshot; this function
// copies it out.
//
// An agent that does no I/O may leave it out, which means no effects.

import type { EffectRequest } from './request.js';
import type { JsonObject } from './json.js';
import type { State } from './state.js';

/** S is the agent's snapshot type, C its config type. */
export type Effects<S extends JsonObject, C extends JsonObject> = (
  state: State<S, C>,
) => EffectRequest[];
