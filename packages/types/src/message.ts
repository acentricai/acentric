// Layer 1: messages. A message is something that happened to the agent.
// `step` receives exactly one at a time.
//
// Every message is identified by whoever created the thing it is about:
// an input by the caller's `id`, an effect result by the `key` the agent
// chose when it asked. The runner never invents identities.

import type { Json, JsonObject } from './json.js';

/** The outside world sent something, such as a user's chat message. */
export type InputMessage = {
  type: 'input';
  /** Chosen by the caller. Unique per input. */
  id: string;
  /** The agent's own label, such as 'chat' or 'steer'. */
  kind: string;
  payload: JsonObject;
};

/** A handler the agent asked for has finished. */
export type EffectMessage = {
  type: 'effect';
  /** The key the agent used when it asked for this effect. */
  key: string;
  /** Which handler ran. */
  kind: string;
  outcome: Outcome;
};

/**
 * What a handler produced.
 *   - ok: it returned a value.
 *   - failed: it did not succeed.
 *   - interrupted: a 'once' handler was cut off by a crash. It may or may
 *     not have done its work, and it will not be run again.
 */
export type Outcome = { ok: Json } | { failed: Failure } | { interrupted: true };

export type Failure = {
  /** Set by the runner, so `step` can branch on what went wrong. */
  code: FailureCode;
  /** The detail: what the handler threw, made into Json by the runner. */
  error: Json;
};

export type FailureCode =
  /** The handler threw. */
  | 'threw'
  /** The handler ran past its time limit. */
  | 'timeout'
  /** The handler returned something that is not Json. */
  | 'invalid_result'
  /** No handler exists for the requested kind. */
  | 'unknown_kind'
  /** A 'reissue' handler was cut off by crashes too many times. */
  | 'attempts_exhausted';

/** The agent's configuration changed. The new config is also in the state. */
export type ConfigMessage = {
  type: 'config';
  config: JsonObject;
};

/**
 * The instance was just upgraded to this version of the agent's code. It is
 * the first message the new version's step receives, after migrate.
 */
export type MigratedMessage = {
  type: 'migrated';
  /** The version the instance was upgraded from. */
  from: string;
};

/**
 * A caller asks the agent to pause. The runner only delivers it: step
 * decides what pausing means, such as finishing what is running and
 * starting nothing new, or cancelling everything now. Messages keep
 * arriving while paused, and step decides what to do with them.
 */
export type PauseMessage = {
  type: 'pause';
  reason?: Json;
};

/**
 * A caller asks the agent to carry on. As with pause, step decides what
 * that means, from what its own snapshot says it was doing.
 */
export type ResumeMessage = {
  type: 'resume';
  reason?: Json;
};

export type Message =
  InputMessage | EffectMessage | ConfigMessage | MigratedMessage | PauseMessage | ResumeMessage;
