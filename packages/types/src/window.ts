// Layer 2: window. Decides how much of the log the next step sees.
//
// A log grows for as long as an agent lives, and a step is pure, so the
// runner must load what it needs before calling it. Only the agent knows
// what it still needs, such as everything since its last summary, so it
// says so here: the first seq the next step needs. Older entries stay
// stored, and a handler can still read them.
//
// The runner calls it after init, after every accepted step and after
// migrate. It takes the snapshot alone: it decides which log to load, so it
// cannot depend on the log. It may move backwards, to load older entries
// again for a while. A value below 1 means 1, and one above the next seq
// means no entries. The runner may refuse a window larger than its limit.
//
// An agent that leaves it out sees the whole log.

import type { JsonObject } from './json.js';

/** S is the agent's snapshot type. Pure. */
export type Window<S extends JsonObject> = (snapshot: S) => number;
