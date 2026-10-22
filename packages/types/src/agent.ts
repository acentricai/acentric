// Layer 2: the agent. Everything a developer writes, in one object, and
// what a runner takes.
//
// The pure half decides: init creates the first state, step handles one
// message at a time, effects lists the I/O that should be running. The
// impure half acts: handlers do that I/O. A runner connects them.

import type { Effects } from './effects.js';
import type { Handlers } from './handler.js';
import type { Init } from './init.js';
import type { JsonObject } from './json.js';
import type { Step } from './step.js';

/** The config of an agent that takes none: an object with no fields. */
export type NoConfig = Record<string, never>;

/**
 * S is the agent's snapshot type, C its config type. C defaults to
 * NoConfig, for agents that take none.
 *
 * Effect kinds are plain strings: a kind with no handler is reported to
 * step as an 'unknown_kind' failure at runtime, not caught by TypeScript.
 */
export type Agent<S extends JsonObject, C extends JsonObject = NoConfig> = {
  init: Init<S, C>;
  step: Step<S, C>;
  /** Left out by an agent that does no I/O: no effects. */
  effects?: Effects<S, C>;
  /** Left out by an agent with no handlers of its own, such as one using only runner kinds. */
  handlers?: Handlers;
};
