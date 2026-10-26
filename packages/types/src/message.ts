// Layer 1: messages. A message is something that happened to the agent.
// `step` receives exactly one at a time.
//
// A message type exists only for something the runner itself does: delivers
// a caller's input, reports an effect, changes the config, upgrades the
// agent. Anything else an agent understands, such as a request to pause, is
// an input with a kind of the agent's choosing.
//
// Every message is identified by whoever created the thing it is about:
// an input by the caller's `id`, an effect result by the `key` the agent
// chose when it asked. The runner never invents identities.
//
// Messages are readonly, like state. A runner may deliver the same message
// again after a failed step, so a step must not change the one it is given.

import type { Json, JsonObject } from './json.js';
import type { Kinds } from './request.js';

/** The outside world sent something, such as a user's chat message. */
export type InputMessage = {
  readonly type: 'input';
  /** Chosen by the caller. Unique per input. */
  readonly id: string;
  /** The agent's own label, such as 'chat' or 'steer'. */
  readonly kind: string;
  readonly payload: JsonObject;
};

/**
 * A handler the agent asked for has finished. K is the agent's map of
 * kinds; there is one variant per kind, so checking `kind` gives `outcome`
 * that kind's result type.
 */
export type EffectMessage<K extends Kinds = Kinds> = {
  [N in keyof K & string]: {
    readonly type: 'effect';
    /** The key the agent used when it asked for this effect. */
    readonly key: string;
    /** Which handler ran. */
    readonly kind: N;
    readonly outcome: Outcome<K[N]['result']>;
  };
}[keyof K & string];

/**
 * What a handler produced. R is the handler's result type.
 *   - ok: it returned a value.
 *   - failed: it did not succeed.
 *   - interrupted: a 'once' handler was cut off by a crash. It may or may
 *     not have done its work, and it will not be run again.
 */
export type Outcome<R extends Json = Json> =
  { readonly ok: R } | { readonly failed: Failure } | { readonly interrupted: true };

export type Failure = {
  /** Set by the runner, so `step` can branch on what went wrong. */
  readonly code: FailureCode;
  /**
   * The detail: what the handler threw, made into Json by the runner. When
   * the thrown value has a `toJSON()` that returns Json, it is what that
   * returns, on every runner.
   */
  readonly error: Json;
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
  | 'attempts_exhausted'
  /** The agent asked it to stop with `abort`, and it stopped without returning a result. */
  | 'aborted'
  /**
   * It went over one of the runner's limits, such as too many effects
   * declared at once, or args or a result too large. `error` says which
   * limit and its maximum.
   */
  | 'limit_exceeded';

/**
 * A caller is changing the agent's configuration to `config`. The step that
 * receives it still sees the current config in its state, so it can compare
 * the two. If the step accepts, the new config applies from then on: to the
 * effects, view and window of the state it returns, and to every later step.
 */
export type ConfigMessage = {
  readonly type: 'config';
  readonly config: JsonObject;
};

/**
 * The session was just upgraded to this version of the agent's code. It is
 * the first message the new version's step receives, after migrate.
 */
export type MigratedMessage = {
  readonly type: 'migrated';
  /** The version the session was upgraded from. */
  readonly from: string;
};

/** Every message a step can receive. K is the agent's map of kinds. */
export type Message<K extends Kinds = Kinds> =
  InputMessage | EffectMessage<K> | ConfigMessage | MigratedMessage;
