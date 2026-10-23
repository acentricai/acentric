// A handler host: the child process that loads one bundle's handlers module
// and runs its effects. The runner starts it with the module's path and
// talks to it in JSON-RPC over the IPC channel:
//
//   runner -> host   describe            the kinds the module provides
//   runner -> host   effect/run          runs one effect, answering with its outcome
//   runner -> host   effect/cancel       fires the effect's signal (notification)
//   host -> runner   effect/emit         a delta the handler emitted (notification)
//   host -> runner   secrets/get, log/list
//
// The host exits when the IPC channel closes. Its stdout goes to the
// runner's stderr, so a handler's console.log never mixes with a protocol
// the runner speaks on its own stdout.

import { pathToFileURL } from 'node:url';

import type {
  HandlerContext,
  HandlerDef,
  Json,
  JsonObject,
  LogPage,
  LogQuery,
} from '@acentric/types';

import { isJson, thrownToJson } from '../json.js';
import { RpcError, RpcPeer } from '@acentric/protocol';
import type { RpcMessage } from '@acentric/protocol';

const path = process.argv[2];
if (path === undefined) throw new Error('the handler host needs the handlers module path');

// The runner may be gone, such as after it was killed: a send that fails
// means there is no one left to answer, so the host exits.
const send = (message: RpcMessage): void => {
  if (!process.connected) return;
  process.send?.(message, undefined, {}, (error) => {
    if (error !== null) process.exit(0);
  });
};

const running = new Map<string, AbortController>();
let handlers: Record<string, HandlerDef> | null = null;

const peer = new RpcPeer(send, {
  request: async (method, params) => {
    if (method === 'describe') return describe(await load());
    if (method === 'effect/run') return run(await load(), params);
    throw new RpcError(-32601, `unknown method ${method}`);
  },
  notify: (method, params) => {
    if (method !== 'effect/cancel' || !isObject(params)) return;
    running.get(runKey(params))?.abort();
  },
});

process.on('message', (message) => peer.receive(message));
process.on('disconnect', () => process.exit(0));

async function load(): Promise<Record<string, HandlerDef>> {
  if (handlers !== null) return handlers;
  const module: unknown = await import(pathToFileURL(path ?? '').href);
  const exported: unknown = isObject(module) ? Reflect.get(module, 'default') : undefined;
  if (!isObject(exported))
    throw new RpcError(1, 'the handlers module has no default export of handlers');
  const loaded: Record<string, HandlerDef> = {};
  for (const [kind, def] of Object.entries(exported)) {
    if (kind.startsWith('@')) {
      throw new RpcError(1, `handler names starting with @ belong to runners: ${kind}`);
    }
    if (!isHandlerDef(def)) throw new RpcError(1, `handler ${kind} has no mode and run function`);
    loaded[kind] = def;
  }
  handlers = loaded;
  return loaded;
}

function describe(loaded: Record<string, HandlerDef>): Json {
  const kinds: JsonObject = {};
  for (const [kind, def] of Object.entries(loaded)) {
    kinds[kind] = {
      mode: def.mode,
      ...(def.timeoutMs === undefined ? {} : { timeoutMs: def.timeoutMs }),
      ...(def.maxAttempts === undefined ? {} : { maxAttempts: def.maxAttempts }),
    };
  }
  return { kinds };
}

async function run(loaded: Record<string, HandlerDef>, params: Json): Promise<Json> {
  if (!isObject(params)) throw new RpcError(-32602, 'effect/run needs params');
  const { session, key, kind, args, attempt } = params;
  if (typeof session !== 'string' || typeof key !== 'string' || typeof kind !== 'string') {
    throw new RpcError(-32602, 'effect/run needs session, key and kind');
  }
  const handler = loaded[kind];
  if (handler === undefined) throw new RpcError(1, `no handler for ${kind}`);
  const controller = new AbortController();
  const id = runKey(params);
  running.set(id, controller);
  const ctx: HandlerContext = {
    key,
    kind,
    args: args ?? null,
    attempt: typeof attempt === 'number' ? attempt : 1,
    signal: controller.signal,
    emit: (delta) => {
      if (isJson(delta)) peer.notify('effect/emit', { session, key, delta });
    },
    secrets: {
      get: async (name) => {
        const value = await peer.request('secrets/get', { name });
        if (typeof value !== 'string') throw new Error(`secret ${name} is not set`);
        return value;
      },
    },
    log: {
      list: async (query?: LogQuery) =>
        toPage(await peer.request('log/list', { session, query: query ?? {} })),
    },
  };
  try {
    const value: unknown = await handler.run(ctx);
    return isJson(value) ? { value } : { invalid: true };
  } catch (error) {
    return { thrown: thrownToJson(error) };
  } finally {
    running.delete(id);
  }
}

function runKey(params: JsonObject): string {
  return JSON.stringify([params['session'] ?? null, params['key'] ?? null]);
}

function toPage(value: Json): LogPage {
  if (!isObject(value) || !Array.isArray(value['entries']))
    throw new Error('the runner sent no log page');
  const entries = value['entries'].filter(isObject).map((entry) => ({
    seq: Number(entry['seq']),
    at: Number(entry['at']),
    kind: typeof entry['kind'] === 'string' ? entry['kind'] : '',
    body: entry['body'] ?? null,
  }));
  const cursor = value['cursor'];
  return typeof cursor === 'string' ? { entries, cursor } : { entries };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHandlerDef(value: unknown): value is HandlerDef {
  if (!isObject(value)) return false;
  const mode: unknown = Reflect.get(value, 'mode');
  return (mode === 'reissue' || mode === 'once') && typeof Reflect.get(value, 'run') === 'function';
}
