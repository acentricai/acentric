// The trusted worker of one workerd process. The engine holds one WebSocket to it and sends
// every call over it. This worker loads agents' code with the worker loader, each under the
// key the engine gave it, and calls into them.
//
// Engine to host (JSON text frames):
//   { t: 'call', id, key, code?, path, argument, context }
//   { t: 'inspect', id, key, code }
//   { t: 'cancel', id }
//   { t: 'secret', id, sid, value } | { t: 'secret', id, sid, error: { name, message } }
//   { t: 'ping', n }
// Host to engine:
//   { t: 'result', id, result }      how the call ended, or what the code said it is
//   { t: 'needCode', id }            this process does not hold the code: send the call again with it
//   { t: 'failed', id, load, message }   the code did not load, or the call could not be made
//   { t: 'secret', id, sid, name }   the agent's code asks for a secret, in call `id`
//   { t: 'pong', n, loaded, loading, queued }
//   { t: 'loaded', key, loading, queued }   code finished loading, or failed to
// A message longer than PART characters goes as frames { t: 'part', d } and a last
// { t: 'last', d }, whose `d`s joined are the message.

import { RpcTarget } from 'cloudflare:workers';
import SHIM from './shim.txt';

const PART = 256 * 1024;

// Code sent for keys the loader has not asked for yet.
const codes = new Map();
// Keys the loader holds.
const loaded = new Set();
// Keys whose code loaded and answered once: calls into them start at once.
const ready = new Set();
// Loads under way, by key, so calls that come meanwhile wait for the same one.
const warming = new Map();

// At most LOAD_CONCURRENCY loads at once, the rest queued: compiling code holds the one
// thread, and between loads the thread answers pings and calls.
let loading = 0;
const queue = [];
async function gated(limit, work) {
  if (loading >= limit) await new Promise((resolve) => queue.push(resolve));
  loading += 1;
  try {
    return await work();
  } finally {
    loading -= 1;
    queue.shift()?.();
  }
}

// Loader names are `<key>:<generation>`: a load that failed for want of code moves the key to
// a new name, so the failure is not what the loader keeps.
const generations = new Map();

function load(env, key) {
  const generation = generations.get(key) ?? 0;
  const worker = env.LOADER.get(`${key}:${generation}`, () => {
    const code = codes.get(key);
    if (code === undefined) {
      generations.set(key, generation + 1);
      loaded.delete(key);
      throw new Error(`this process does not hold the code of ${key}`);
    }
    codes.delete(key);
    loaded.add(key);
    return {
      compatibilityDate: env.COMPATIBILITY_DATE,
      // The web platform only.
      compatibilityFlags: ['no_nodejs_compat', 'no_nodejs_compat_v2'],
      mainModule: 'shim.js',
      modules: { 'shim.js': SHIM, '__agent__.js': code },
      env: {},
      globalOutbound: env.NET,
    };
  });
  return { worker, generation };
}

/** What one call's code may reach of the engine: the secrets of its agent. */
class CallHost extends RpcTarget {
  #connection;
  #id;
  constructor(connection, id) {
    super();
    this.#connection = connection;
    this.#id = id;
  }
  secret(name) {
    return this.#connection.ask(this.#id, name);
  }
}

class Connection {
  #socket;
  #env;
  #parts = [];
  // Calls the engine waits for, by id.
  #calls = new Map();
  // Secrets asked for and not answered yet, by `${id}/${sid}`.
  #secrets = new Map();
  #sid = 0;

  constructor(socket, env) {
    this.#socket = socket;
    this.#env = env;
  }

  send(message) {
    const text = JSON.stringify(message);
    if (text.length <= PART) return this.#socket.send(text);
    for (let at = 0; at < text.length; at += PART) {
      const t = at + PART >= text.length ? 'last' : 'part';
      this.#socket.send(JSON.stringify({ t, d: text.slice(at, at + PART) }));
    }
  }

  receive(data) {
    let message = JSON.parse(data);
    if (message.t === 'part') return void this.#parts.push(message.d);
    if (message.t === 'last') {
      this.#parts.push(message.d);
      message = JSON.parse(this.#parts.join(''));
      this.#parts = [];
    }
    switch (message.t) {
      case 'ping':
        return this.send({
          t: 'pong',
          n: message.n,
          loaded: loaded.size,
          loading,
          queued: queue.length,
        });
      case 'call':
      case 'inspect':
        return void this.#start(message);
      case 'cancel':
        return this.#cancel(message.id);
      case 'secret': {
        const key = `${message.id}/${message.sid}`;
        const waiting = this.#secrets.get(key);
        this.#secrets.delete(key);
        return waiting?.resolve(
          message.error === undefined ? { value: message.value } : { error: message.error },
        );
      }
      default:
        return undefined;
    }
  }

  /** Asks the engine for a secret, for call `id`. */
  ask(id, name) {
    if (!this.#calls.has(id)) {
      return { error: { name: 'Error', message: 'the call is over' } };
    }
    const sid = ++this.#sid;
    return new Promise((resolve) => {
      this.#secrets.set(`${id}/${sid}`, { id, resolve });
      this.send({ t: 'secret', id, sid, name });
    });
  }

  /**
   * The engine stopped waiting for call `id`. Nothing of it is kept here, even while its code
   * goes on running: the secrets it waits for are refused, and any it asks for later.
   */
  #cancel(id) {
    if (!this.#calls.delete(id)) return;
    for (const [key, waiting] of this.#secrets) {
      if (waiting.id !== id) continue;
      this.#secrets.delete(key);
      waiting.resolve({ error: { name: 'AbortError', message: 'the call was stopped' } });
    }
  }

  /** The engine went away: everything it started is given up. */
  closed() {
    for (const id of this.#calls.keys()) this.#cancel(id);
  }

  /** Loads code, in turn with other loads. A load that fails is left for the call to fail the same way. */
  async #warm(worker, key) {
    let warm = warming.get(key);
    if (warm === undefined) {
      warm = gated(Number(this.#env.LOAD_CONCURRENCY), () => worker.getEntrypoint().ready())
        .then(
          () => void ready.add(key),
          () => {},
        )
        .finally(() => {
          warming.delete(key);
          // Progress the engine sees as proof of life, and its load counts.
          this.send({ t: 'loaded', key, loading, queued: queue.length });
        });
      warming.set(key, warm);
    }
    await warm;
  }

  async #start({ t, id, key, code, path, argument, context }) {
    if (code !== undefined && !loaded.has(key)) codes.set(key, code);
    if (!loaded.has(key) && !codes.has(key)) return this.send({ t: 'needCode', id });
    const { worker, generation } = load(this.#env, key);
    const call = {};
    this.#calls.set(id, call);
    try {
      if (!ready.has(key)) {
        await this.#warm(worker, key);
        // Given up while it waited for its load: it never runs.
        if (this.#calls.get(id) !== call) return this.send({ t: 'result', id, result: null });
      }
      const entrypoint = worker.getEntrypoint();
      const result =
        t === 'inspect'
          ? await entrypoint.describe()
          : await entrypoint.call(path, argument, context, new CallHost(this, id));
      this.send({ t: 'result', id, result });
    } catch (error) {
      if ((generations.get(key) ?? 0) !== generation) return this.send({ t: 'needCode', id });
      // Code that does not load fails every call. Code that answers `describe` loaded, and
      // this call failed for another reason.
      const unloadable =
        t === 'inspect' ||
        (await worker
          .getEntrypoint()
          .describe()
          .then(
            () => false,
            () => true,
          ));
      this.send({
        t: 'failed',
        id,
        load: unloadable,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Whether the engine still waits or not, the end of the call goes to it: it counts the
      // calls it gave up whose code is still running.
      if (this.#calls.get(id) === call) this.#calls.delete(id);
    }
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('token') !== env.TOKEN) return new Response('no', { status: 403 });
    if (request.headers.get('upgrade') !== 'websocket') return new Response('no', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const connection = new Connection(server, env);
    server.addEventListener('message', (event) => connection.receive(event.data));
    server.addEventListener('close', () => connection.closed());
    server.addEventListener('error', () => connection.closed());
    return new Response(null, { status: 101, webSocket: client });
  },
};
