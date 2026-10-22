// Layer 2: view. The agent's public face.
//
// The snapshot is the agent's private memory: it holds internals such as
// pending effect keys, and its shape changes as the agent is rewritten. A
// view turns the state into what callers and UIs should see, in a shape the
// agent keeps stable for them while its snapshot changes freely.
//
// When a view is computed, stored and served is the runner's policy. It may
// compute it after every step and store it, so reading it runs no agent
// code, or compute it when asked. An agent that leaves it out lets the
// runner decide what to show.
//
// It takes no `now`, so it depends on the state alone, like `effects`.

import type { JsonObject } from './json.js';
import type { State } from './state.js';

/** S is the agent's snapshot type, C its config type. Pure. */
export type View<S extends JsonObject, C extends JsonObject> = (state: State<S, C>) => JsonObject;
