// The probe's handlers module: one kind for each thing a scenario needs a
// handler to do.
//
//   echo       returns args.value
//   throw      throws an Error with args.message
//   invalid    returns undefined, which is not Json
//   sleep      waits args.ms, or returns { aborted: true } when signalled
//   slow       sleep with a 50 ms time limit
//   gate       waits until the scenario releases it; at most 2 attempts
//   read_log   returns a page of ctx.log.list(args.query)
//   attempt    returns ctx.attempt
//   secret     reads the secret args.name: { set: true }, or { rejected: name }
//              with the name of the error it rejected with; never its value

import type { HandlerDef, Handlers, Json, JsonObject, LogQuery } from '@acentric/types';

import { installedHook } from '../hook.js';

function arg(args: Json, name: string): Json | undefined {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args[name] : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<Json> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ aborted: true });
      return;
    }
    const timer = setTimeout(() => resolve({ slept: ms }), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve({ aborted: true });
      },
      { once: true },
    );
  });
}

const sleeper: HandlerDef = {
  mode: 'reissue',
  run: (ctx) => {
    const ms = arg(ctx.args, 'ms');
    return sleep(typeof ms === 'number' ? ms : 0, ctx.signal);
  },
};

const handlers: Handlers = {
  echo: { mode: 'reissue', run: (ctx) => Promise.resolve(arg(ctx.args, 'value') ?? null) },
  throw: {
    mode: 'reissue',
    run: (ctx) => {
      const message = arg(ctx.args, 'message');
      return Promise.reject(new Error(typeof message === 'string' ? message : 'thrown'));
    },
  },
  invalid: {
    mode: 'reissue',
    // Deliberately not Json, so the runner reports invalid_result.
    run: () => Promise.resolve(JSON.parse('null') ?? Reflect.get({}, 'missing')),
  },
  sleep: sleeper,
  slow: { ...sleeper, timeoutMs: 50 },
  gate: {
    mode: 'reissue',
    maxAttempts: 2,
    run: async (ctx) => {
      const hook = installedHook();
      if (hook === null) throw new Error('no conformance hook is installed');
      const outcome = await hook.gate(ctx.key, ctx.signal);
      if ('throw' in outcome) throw new Error(outcome.throw);
      return outcome.return;
    },
  },
  read_log: {
    mode: 'reissue',
    run: async (ctx) => {
      const query = arg(ctx.args, 'query');
      const page = await ctx.log.list(isQuery(query) ? query : {});
      const entries: JsonObject[] = page.entries.map((entry) => ({ ...entry }));
      return page.cursor === undefined ? { entries } : { entries, cursor: page.cursor };
    },
  },
  attempt: { mode: 'reissue', run: (ctx) => Promise.resolve(ctx.attempt) },
  secret: {
    mode: 'reissue',
    run: async (ctx) => {
      const name = arg(ctx.args, 'name');
      try {
        await ctx.secrets.get(typeof name === 'string' ? name : '');
        return { set: true };
      } catch (error) {
        return { rejected: error instanceof Error ? error.name : null };
      }
    },
  },
};

function isQuery(value: Json | undefined): value is LogQuery & JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default handlers;
