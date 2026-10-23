// A handler context for tests: everything a runner would give a handler,
// backed by plain values, so a handler can be run on its own.

import type { HandlerContext, Json, LogEntry, LogPage, LogQuery } from '@acentric/types';

export type HandlerContextOptions<A extends Json> = {
  args: A;
  key?: string;
  kind?: string;
  attempt?: number;
  /** The agent's log, oldest first. */
  log?: readonly LogEntry[];
  /** Secret values by name. Reading one that is missing throws, as a runner would. */
  secrets?: Record<string, string>;
  /** The most entries one page of `log.list` returns. Defaults to 100. */
  pageSize?: number;
};

export type TestHandlerContext<A extends Json> = {
  ctx: HandlerContext<A>;
  /** Fires the handler's signal, as a cancel or abort would. */
  controller: AbortController;
  /** Every delta the handler emitted, in order. */
  emitted: Json[];
};

export function handlerContext<A extends Json>(
  options: HandlerContextOptions<A>,
): TestHandlerContext<A> {
  const controller = new AbortController();
  const emitted: Json[] = [];
  const log = options.log ?? [];
  const secrets = options.secrets ?? {};
  const pageSize = options.pageSize ?? 100;

  const ctx: HandlerContext<A> = {
    key: options.key ?? 'effect:1',
    kind: options.kind ?? 'effect',
    args: options.args,
    attempt: options.attempt ?? 1,
    signal: controller.signal,
    emit: (delta) => {
      emitted.push(delta);
    },
    secrets: {
      get: (name) => {
        const value = secrets[name];
        return value === undefined
          ? Promise.reject(new Error(`secret ${name} is not set`))
          : Promise.resolve(value);
      },
    },
    log: {
      list: (query = {}) => Promise.resolve(listLog(log, query, pageSize)),
    },
  };
  return { ctx, controller, emitted };
}

function listLog(log: readonly LogEntry[], query: LogQuery, pageSize: number): LogPage {
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  const matching = log.filter(
    (entry) =>
      (query.after === undefined || entry.seq > query.after) &&
      (query.before === undefined || entry.seq < query.before) &&
      (query.kinds === undefined || query.kinds.includes(entry.kind)),
  );
  const limit = Math.min(query.limit ?? pageSize, pageSize);
  const entries = matching.slice(offset, offset + limit);
  const next = offset + entries.length;
  return next < matching.length ? { entries, cursor: String(next) } : { entries };
}
