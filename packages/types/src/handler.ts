// Layer 2: handlers. The only code that does I/O.
//
// A handler runs when `effects` asks for its kind. What it does inside is
// up to it and to the runner that hosts it: fetch, files, shell commands,
// databases. The framework only fixes what goes in (the context), what comes
// out (Json) and how it is stopped (the signal). So the context holds
// nothing tied to one environment: no fetch, no file system.
//
// A handler depends only on its args. Anything it needs from the agent's
// config or state is copied into args by `effects`. Secrets are the
// exception: they must never be in args, state or the log, where they would
// be stored, so the handler asks for them by name.

import type { Json } from './json.js';
import type { Mode } from './request.js';

/** Reads secrets by name. Each runner decides where the values come from. */
export type Secrets = {
  get(name: string): Promise<string>;
};

/** What a handler receives. A is the handler's args type. */
export type HandlerContext<A extends Json = Json> = {
  /** This effect's key. Also usable as an idempotency key for external APIs. */
  key: string;
  /** The kind that was requested. */
  kind: string;
  /** The request's args. */
  args: A;
  /** 1 on the first run; higher when a 'reissue' handler runs again after a crash. */
  attempt: number;
  /**
   * Fires when the effect is cancelled, aborted or times out. Pass it to
   * whatever does the I/O. When it fires, returning what the handler has so
   * far is always safe: an aborted effect delivers it, and a cancelled one
   * discards it.
   */
  signal: AbortSignal;
  /** Sends live progress, such as streamed tokens. Best effort; never saved. */
  emit(delta: Json): void;
  secrets: Secrets;
};

/**
 * One handler. A is its args type and R its result type; both are checked
 * by TypeScript only, not at runtime.
 *
 * The runner turns what `run` does into the outcome `step` receives:
 *   - returns a Json value: { ok: value }
 *   - throws: { failed: { code: 'threw', error } }, or code 'aborted' when
 *     it throws after the agent asked it to stop
 *   - returns something that is not Json: { failed: { code: 'invalid_result', error } }
 */
export type HandlerDef<A extends Json = Json, R extends Json = Json> = {
  /** Required, so every handler states whether it is safe to repeat. */
  mode: Mode;
  run(ctx: HandlerContext<A>): Promise<R>;
  /** Overrides the runner's time limit for one run, in milliseconds. */
  timeoutMs?: number;
  /** Overrides the runner's limit on runs of one key. Applies to 'reissue' only. */
  maxAttempts?: number;
};

/**
 * An agent's handlers, by kind name. A handler with its own args and result
 * types fits here because `run` is declared as a method, whose parameter
 * TypeScript checks in both directions.
 */
export type Handlers = Record<string, HandlerDef>;
