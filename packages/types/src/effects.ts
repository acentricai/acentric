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
//   - aborts a running key newly marked `abort`, and delivers its result,
//   - ignores keys that already finished, since keys are single-use,
//   - treats the same key twice in one list as a bug.
//
// A runner sets its own limits; the framework fixes only what the agent
// experiences. An effect over a limit on effects declared at once, or on
// the size of its args or result, fails on its own with 'limit_exceeded',
// and the step is applied as usual. Over the limit on declared effects, the
// ones at the end of the list are refused. An effect over a limit on how
// many run at once, overall or per kind, waits its turn; the agent sees
// nothing, and its time limit starts only when it starts running.
//
// It takes no `now`. The list must depend on the state alone, so the runner
// gets the same answer whenever it asks, including after a restart. A step
// computes any time once and stores it in the snapshot; this function
// copies it out.
//
// An agent that does no I/O may leave it out, which means no effects.

import type { EffectRequest, Kinds } from './request.js';
import type { JsonObject } from './json.js';
import type { State } from './state.js';

/**
 * S is the agent's snapshot type, C its config type and K its map of kinds,
 * which decides the kinds and args it may request.
 */
export type Effects<S extends JsonObject, C extends JsonObject, K extends Kinds = Kinds> = (
  state: State<S, C>,
) => EffectRequest<K>[];
