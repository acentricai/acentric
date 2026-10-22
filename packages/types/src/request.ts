// Layer 1: effects. An effect is the agent asking for I/O, described as
// data. It does no work itself.
//
// The agent does not issue start or cancel commands. After every step, a
// pure function returns every effect that should exist right now, and the
// runner compares that list with what is running: a new key starts, a key
// that disappears is cancelled and never sends a result.
//
// To stop a running effect but still receive what it has so far, such as
// the partial text of a streaming reply, the agent keeps its key and marks
// it `abort`.
//
// Keys are chosen by the agent and are single-use: once a key's result has
// been delivered, that key is never run again. New work needs a new key.
//
// A runner may provide built-in kinds of its own, such as a timer. They are
// requested and answered like any other kind.

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
export type EffectRequest = {
  key: string;
  /** Which handler runs it: one of the agent's, or one the runner provides. */
  kind: string;
  /**
   * Input for the handler. Fixed for the life of the key. A time in it
   * should be absolute, in the same units as a step's `now`, so it means
   * the same thing when the handler runs again after a crash.
   */
  args: Json;
  /** Overrides the handler's default mode for this request. */
  mode?: Mode;
  /**
   * Stop the running handler, but still deliver what it returns. The one
   * field the runner acts on when it changes on a running key. It cannot be
   * undone: once set, the handler's signal has fired.
   */
  abort?: boolean;
};
