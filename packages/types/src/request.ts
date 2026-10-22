// Layer 1: effects. An effect is the agent asking for I/O, described as
// data. It does no work itself.
//
// The agent does not issue start or cancel commands. After every step, a
// pure function returns every effect that should exist right now, and the
// runner compares that list with what is running: a new key starts, a key
// that disappears is cancelled and never sends a result.
//
// Keys are chosen by the agent and are single-use: once a key's result has
// been delivered, that key is never run again. New work needs a new key.

import type { Json } from './json.js';

/**
 * Whether a handler may run again after the runner crashed mid-run.
 *   - 'reissue': at least once. Run it again. For work that is safe to
 *     repeat, such as an LLM call or a search.
 *   - 'once': at most once. Never run it again; the agent receives
 *     `interrupted` instead. For work that must not repeat, such as sending
 *     an email or making a payment.
 */
export type Mode = 'reissue' | 'once';

/** Run a handler. Its result arrives as an `effect` message with this key. */
export type HandlerRequest = {
  type: 'handler';
  key: string;
  /** Which handler runs it. */
  kind: string;
  /** Input for the handler. Fixed for the life of the key. */
  args: Json;
  /** Overrides the handler's default mode for this request. */
  mode?: Mode;
};

/** Wake the agent at a time. It arrives as a `timer` message with this key. */
export type TimerRequest = {
  type: 'timer';
  key: string;
  /**
   * When to fire: an absolute time, in the same units as a step's `now`.
   * Absolute, so a runner restarting after a crash still knows when it is
   * due, and fires it at once if that time has already passed.
   */
  at: number;
};

export type EffectRequest = HandlerRequest | TimerRequest;
