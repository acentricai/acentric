// Layer 2: the agent. Everything a developer writes, in one object, and
// what a runner takes.
//
// The pure half decides: init creates the first state, step handles one
// message at a time, effects lists the I/O that should be running, view
// shows the state to callers. The impure half acts: handlers do that I/O.
// A runner connects them.

import type { Effects } from './effects.js';
import type { HandlersFor } from './handler.js';
import type { Init } from './init.js';
import type { JsonObject } from './json.js';
import type { Migrate } from './migrate.js';
import type { Kinds } from './request.js';
import type { Step } from './step.js';
import type { View } from './view.js';
import type { Window } from './window.js';

/** The config of an agent that takes none: an object with no fields. */
export type NoConfig = Record<string, never>;

/**
 * S is the agent's snapshot type, C its config type and K its map of kinds.
 * C defaults to NoConfig, for agents that take none.
 *
 * K defaults to any kind name with any Json args and results. Given a
 * precise map, such as `KindsOf<typeof handlers> & SomeRunnerKinds`,
 * TypeScript checks the kinds and args `effects` requests, the handlers the
 * agent provides, and types each kind's result in step. A kind with no
 * handler at runtime still reaches step as an 'unknown_kind' failure.
 */
export type Agent<
  S extends JsonObject,
  C extends JsonObject = NoConfig,
  K extends Kinds = Kinds,
> = {
  /**
   * Identifies the agent's code, like a package name, such as
   * 'support-bot'. Every instance created from this code shares it.
   */
  name: string;
  /**
   * Identifies this version of the code, such as '2.0'. Chosen by the
   * author; the framework never compares versions, only migrate reads them.
   */
  version: string;
  init: Init<S, C>;
  step: Step<S, C, K>;
  /** Left out by an agent that does no I/O: no effects. */
  effects?: Effects<S, C, K>;
  /** Left out by an agent with no handlers of its own, such as one using only runner kinds. */
  handlers?: HandlersFor<K>;
  /** Left out by an agent whose snapshot and config keep their shapes across upgrades. */
  migrate?: Migrate<S, C>;
  /** Left out by an agent that leaves to the runner what callers see. */
  view?: View<S, C>;
  /** Left out by an agent whose steps see the whole log. */
  window?: Window<S>;
};
