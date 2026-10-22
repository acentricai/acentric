// Layer 2: handlers. The only code that does I/O.
//
// A handler runs when `effects` asks for its kind. What it does inside is
// up to it and to the runner that hosts it: fetch, files, shell commands,
// databases. The framework only fixes what goes in (the context), what comes
// out (Json) and how it is stopped (the signal). So the context holds
// nothing tied to one environment: no fetch, no file system.
//
// A handler depends only on its args. Anything it needs from the agent's
// config or state is copied into args by `effects`. There are two
// exceptions. Secrets must never be in args, state or the log, where they
// would be stored, so the handler asks for them by name. And the log can be
// far larger than args or a step's window allow, so a handler can read any
// part of it, which is how a step gets at entries below its window.

import type { Json } from './json.js';
import type { Kinds, Mode } from './request.js';
import type { LogEntry } from './state.js';

/** Reads secrets by name. Each runner decides where the values come from. */
export type Secrets = {
  get(name: string): Promise<string>;
};

/** Which log entries to read. Every field narrows the result. */
export type LogQuery = {
  /** Only entries with a seq greater than this. */
  after?: number;
  /** Only entries with a seq less than this. */
  before?: number;
  /** Only entries of these kinds. */
  kinds?: string[];
  /** At most this many entries. The runner may return fewer and caps the most. */
  limit?: number;
  /** Continues from a previous page's `cursor`. */
  cursor?: string;
};

/** One page of log entries, oldest first. */
export type LogPage = {
  readonly entries: readonly LogEntry[];
  /** Present when more entries match: pass it as the next query's `cursor`. */
  readonly cursor?: string;
};

/**
 * Reads the agent's log, anywhere in it. Read-only: only steps append. How
 * entries are stored and paged is the runner's; a runner that deletes old
 * entries says so, and reading them then finds nothing.
 */
export type LogReader = {
  list(query?: LogQuery): Promise<LogPage>;
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
  log: LogReader;
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

/**
 * The map of kinds a set of handlers serves, read from their args and
 * result types. An agent adds its runner's built-in kinds to it:
 *
 *   type MyKinds = KindsOf<typeof handlers> & SomeRunnerKinds;
 */
export type KindsOf<H extends Handlers> = {
  [N in keyof H]: H[N] extends HandlerDef<infer A, infer R> ? { args: A; result: R } : never;
};

/**
 * The handlers an agent may provide for a map of kinds. Each is optional,
 * since some kinds are the runner's built-ins, and each must take and
 * return what its kind says.
 */
export type HandlersFor<K extends Kinds> = {
  [N in keyof K]?: HandlerDef<K[N]['args'], K[N]['result']>;
};
