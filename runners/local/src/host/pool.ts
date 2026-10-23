// Handler hosts, from the runner's side: one child process per bundle,
// started on its first effect and stopped after a while with nothing to
// run. A host that exits while effects run reports them crashed; the next
// effect starts it again, after a backoff if it crashed recently.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Json, JsonObject, LogQuery } from '@acentric/types';

import { RpcError, RpcPeer } from '@acentric/protocol';
import type { KindInfo } from '../store/types.js';

/** What a host answered for one effect. */
export type HostOutcome =
  { value: Json } | { invalid: true } | { thrown: Json } | { crashed: true };

export type EffectRun = {
  instance: string;
  key: string;
  kind: string;
  args: Json;
  attempt: number;
};

export type PoolOptions = {
  /** Node options for host processes, such as `--import` of a module to load first. */
  execArgv?: readonly string[];
  /** Environment variables for host processes, added to the runner's own. */
  env?: Record<string, string>;
  /** How long a host with nothing to run stays up. */
  idleMs: number;
  secret(name: string): string | undefined;
  readLog(instance: string, query: LogQuery): Promise<Json>;
  emitted(instance: string, key: string, delta: Json): void;
};

const CHILD = fileURLToPath(new URL('./child.js', import.meta.url));

type Host = {
  process: ChildProcess;
  peer: RpcPeer;
  running: Map<string, (outcome: HostOutcome) => void>;
  idle: ReturnType<typeof setTimeout> | null;
};

export class HostPool {
  readonly #options: PoolOptions;
  readonly #hosts = new Map<string, Host>();
  /** Recent crash times by bundle hash, for backoff. */
  readonly #crashes = new Map<string, number[]>();
  #closed = false;

  constructor(options: PoolOptions) {
    this.#options = options;
  }

  /** Loads a handlers module in a throwaway host and returns its kinds. */
  async describe(handlersPath: string): Promise<Record<string, KindInfo>> {
    const host = this.#spawn(`describe:${handlersPath}`, handlersPath);
    try {
      const result = await host.peer.request('describe', null);
      return kindsOf(result);
    } finally {
      host.process.kill();
    }
  }

  /** Runs an effect in the bundle's host, starting the host if needed. */
  async run(hash: string, handlersPath: string, effect: EffectRun): Promise<HostOutcome> {
    await this.#backoff(hash);
    if (this.#closed) return { crashed: true };
    const host = this.#hosts.get(hash) ?? this.#start(hash, handlersPath);
    if (host.idle !== null) {
      clearTimeout(host.idle);
      host.idle = null;
    }
    const id = `${effect.instance}\u0000${effect.key}`;
    return new Promise((resolve) => {
      host.running.set(id, resolve);
      host.peer.request('effect/run', effect).then(
        (result) => this.#settle(hash, host, id, outcomeOf(result)),
        () => this.#settle(hash, host, id, { crashed: true }),
      );
    });
  }

  /** Fires an effect's signal, if it is running. */
  cancel(hash: string, instance: string, key: string): void {
    this.#hosts.get(hash)?.peer.notify('effect/cancel', { instance, key });
  }

  /** Stops every host. Effects still running report crashed. */
  close(): void {
    this.#closed = true;
    for (const host of this.#hosts.values()) host.process.kill('SIGKILL');
  }

  #start(hash: string, handlersPath: string): Host {
    const host = this.#spawn(hash, handlersPath);
    this.#hosts.set(hash, host);
    host.process.once('exit', () => {
      if (this.#hosts.get(hash) === host) this.#hosts.delete(hash);
      if (host.running.size > 0) {
        const times = (this.#crashes.get(hash) ?? []).filter((at) => Date.now() - at < 60_000);
        this.#crashes.set(hash, [...times, Date.now()]);
      }
      for (const resolve of host.running.values()) resolve({ crashed: true });
      host.running.clear();
    });
    return host;
  }

  #spawn(name: string, handlersPath: string): Host {
    const child = fork(CHILD, [handlersPath], {
      // The host's stdout goes to the runner's stderr.
      stdio: ['ignore', 2, 2, 'ipc'],
      execArgv: [...(this.#options.execArgv ?? [])],
      env: { ...process.env, ...this.#options.env },
      serialization: 'json',
    });
    const host: Host = {
      process: child,
      running: new Map(),
      idle: null,
      peer: new RpcPeer((message) => child.send(message), {
        request: (method, params) => this.#answer(method, params),
        notify: (method, params) => {
          if (method !== 'effect/emit' || !isObject(params)) return;
          const { instance, key, delta } = params;
          if (typeof instance === 'string' && typeof key === 'string' && delta !== undefined) {
            this.#options.emitted(instance, key, delta);
          }
        },
      }),
    };
    child.on('message', (message) => host.peer.receive(message));
    child.once('exit', (code, signal) => {
      host.peer.close(new Error(`handler host ${name} exited (${signal ?? code ?? 'unknown'})`));
    });
    return host;
  }

  async #answer(method: string, params: Json): Promise<Json> {
    if (!isObject(params)) throw new RpcError(-32602, `${method} needs params`);
    if (method === 'secrets/get') {
      const name = params['name'];
      const value = typeof name === 'string' ? this.#options.secret(name) : undefined;
      if (value === undefined) throw new RpcError(1, `secret ${JSON.stringify(name)} is not set`);
      return value;
    }
    if (method === 'log/list') {
      const instance = params['instance'];
      if (typeof instance !== 'string') throw new RpcError(-32602, 'log/list needs an instance');
      const query = isObject(params['query']) ? toQuery(params['query']) : {};
      return this.#options.readLog(instance, query);
    }
    throw new RpcError(-32601, `unknown method ${method}`);
  }

  #settle(hash: string, host: Host, id: string, outcome: HostOutcome): void {
    const resolve = host.running.get(id);
    if (resolve === undefined) return;
    host.running.delete(id);
    resolve(outcome);
    if (host.running.size === 0 && this.#hosts.get(hash) === host) {
      host.idle = setTimeout(() => {
        if (host.running.size === 0) {
          this.#hosts.delete(hash);
          host.process.disconnect();
        }
      }, this.#options.idleMs);
      host.idle.unref();
    }
  }

  /** Waits before starting a host that crashed recently: 100 ms doubling, up to 5 s. */
  async #backoff(hash: string): Promise<void> {
    if (this.#hosts.has(hash)) return;
    const recent = (this.#crashes.get(hash) ?? []).filter((at) => Date.now() - at < 60_000);
    if (recent.length === 0) return;
    const wait = Math.min(100 * 2 ** (recent.length - 1), 5000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function outcomeOf(result: Json): HostOutcome {
  if (isObject(result)) {
    if ('value' in result) return { value: result['value'] ?? null };
    if (result['invalid'] === true) return { invalid: true };
    if ('thrown' in result) return { thrown: result['thrown'] ?? null };
  }
  return { invalid: true };
}

function kindsOf(result: Json): Record<string, KindInfo> {
  const kinds = isObject(result) ? result['kinds'] : undefined;
  if (!isObject(kinds)) throw new Error('the handler host described no kinds');
  const out: Record<string, KindInfo> = {};
  for (const [kind, info] of Object.entries(kinds)) {
    if (!isObject(info)) continue;
    const { mode, timeoutMs, maxAttempts } = info;
    out[kind] = {
      mode: mode === 'once' ? 'once' : 'reissue',
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof maxAttempts === 'number' ? { maxAttempts } : {}),
    };
  }
  return out;
}

function toQuery(query: JsonObject): LogQuery {
  const { after, before, kinds, limit, cursor } = query;
  return {
    ...(typeof after === 'number' ? { after } : {}),
    ...(typeof before === 'number' ? { before } : {}),
    ...(Array.isArray(kinds) ? { kinds: kinds.filter((kind) => typeof kind === 'string') } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
