// Agents' code in workerd processes, supervised. Each key goes to one of a fixed number of
// slots, the one with the fewest keys when it is first seen, and stays there. Each slot has
// one live process. A watchdog kills one that has sent nothing while a ping waits, and a
// process that grows too large is replaced, at most once per minRecycleMs, by one that is
// ready before the old one stops taking calls and drains.
//
// It is the work of an earlier project of ours, where it was measured under load, brought
// here with what the engine and an agent's code now say to each other.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { Json } from '@acentric/protocol';

import { SandboxLost } from '../errors.ts';
import type { Network } from './config.ts';
import { Sandbox } from './sandbox.ts';
import type { CallSecrets, LossKind, Request } from './sandbox.ts';

export type PoolOptions = {
  /** How many workerd processes. Each runs all of its isolates on one thread. Default 2. */
  readonly processes?: number;
  /** Where agents' code may connect. Default: public addresses only. */
  readonly network?: Network;
  /** How often each process is pinged, and its memory read. Default 2 s. */
  readonly probeMs?: number;
  /**
   * A process that has sent nothing at all for this long while a ping waits
   * is stuck, and is killed and started again. Default 5 s.
   */
  readonly stallMs?: number;
  /**
   * A process whose resident memory passes this is replaced, at a moment it
   * has no calls in flight if one comes within 10 s. Default 1024 MB.
   */
  readonly maxRssMb?: number;
  /** Past this a process is replaced at once, whatever `minRecycleMs` says. Default 1.5 × maxRssMb. */
  readonly hardRssMb?: number;
  /** A process is replaced before it would hold more bundles than this. Default: no fixed count. */
  readonly maxBundles?: number;
  /** A slot's process is replaced at most once per this, but past `hardRssMb`. Default 60 s. */
  readonly minRecycleMs?: number;
  /**
   * A process with no calls for this long, and over half of `maxRssMb`, is
   * replaced, which frees the bundles nobody uses. Default 10 minutes.
   */
  readonly idleRecycleMs?: number;
  /** How long calls in flight on a replaced process may take to finish. Default 30 s. */
  readonly drainMs?: number;
  /**
   * A process is replaced once more than this many calls were cancelled, or
   * timed out, while their code went on running there. Default 20.
   */
  readonly maxAbandoned?: number;
  /** How many bundles one process loads at once; more wait their turn. Default 2. */
  readonly loadConcurrency?: number;
  /** Lines workerd writes. Default: to stderr. */
  readonly log?: (line: string) => void;
  /** The workerd binary. Default: the one of the `workerd` package. */
  readonly binary?: string;
};

/** Why a process was replaced while it was healthy. `inspect`: the process `inspect` uses, cleared. */
export type RecycleReason = 'bundles' | 'rss' | 'abandoned' | 'idle' | 'inspect';

export type ProcessStats = {
  /** The slot the process serves; -1 for the one `inspect` uses. */
  readonly slot: number;
  readonly pid: number;
  /** `draining` while a replaced process lets its calls finish. */
  readonly state: 'live' | 'draining';
  readonly bundles: number;
  readonly inFlight: number;
  /** Calls cancelled or timed out whose code is still running there. */
  readonly abandoned: number;
  /** Bundle loads under way, and waiting their turn, as the process last said. */
  readonly loading: number;
  readonly queuedLoads: number;
  /** How long ago the process last sent anything. */
  readonly lastMessageAgeMs: number;
  /** As last read by the watchdog. */
  readonly rssMb: number;
  /** For the slot: how many times its process was replaced, recycled or killed. */
  readonly restarts: number;
  readonly recycles: Readonly<Record<RecycleReason, number>>;
  readonly kills: Readonly<Record<LossKind, number>>;
  readonly recyclesLastMinute: number;
  /** Recycles the slot wanted and put off for `minRecycleMs`. */
  readonly deferredRecycles: number;
};

export type PoolStats = {
  readonly processes: readonly ProcessStats[];
  /** Calls rejected with SandboxLost, by why. */
  readonly lost: Readonly<Record<LossKind | 'closed', number>>;
  /**
   * Whether the processes hold what is in use. Not ok when a slot recycles
   * more than once a minute or puts recycles off: more distinct bundles are
   * in use than fit in `processes` × `maxRssMb`, and recycling cannot help.
   */
  readonly capacity: { readonly ok: boolean; readonly problems: readonly string[] };
};

/** One call into the code a key names. */
export type CallRequest = {
  readonly path: string;
  readonly argument: Json;
  readonly context: Json;
  /** The secrets of this call: what the code asks for reaches them, and nothing else does. */
  readonly secrets: CallSecrets;
  readonly signal?: AbortSignal;
};

/**
 * Code to call into. `key` is the identity of the loaded module: calls with the same key share
 * one instance of it, with what it keeps between calls, and calls with different keys never
 * do, whatever their code. Any string of 1 to 1024 characters.
 */
export type Keyed = {
  readonly key: string;
  /** Asked for only when the process the key goes to does not hold the code. */
  readonly code: () => Promise<string>;
};

const MAX_KEY = 1024;

/** The worker ID of the module `key` names: a digest, so any key fits. */
function moduleId(key: string): string {
  if (key.length === 0 || key.length > MAX_KEY) {
    throw new TypeError(`A key is a string of 1 to ${String(MAX_KEY)} characters`);
  }
  return createHash('sha256').update(key).digest('hex');
}

export type Pool = {
  /**
   * Loads `code` in a process kept for this, and gives what it says it is, as the code's own
   * answer: `{ protocol, definition }`, or `{ error }`. Rejects with BundleError when the
   * code does not load.
   */
  inspect(code: string): Promise<Json>;
  /**
   * One call into the module `keyed.key` names. Resolves with how the call ended, as the
   * agent's code gave it. Rejects when the call could not be made or has no answer: with the
   * signal's reason when it aborts, SandboxLost, BundleError when the code does not load, or
   * CallFailed.
   */
  call(keyed: Keyed, request: CallRequest): Promise<Json>;
  /** Forgets which process a key went to. The process holds its code until it is replaced. */
  forget(key: string): void;
  stats(): PoolStats;
  /** Kills every process. Calls in flight reject with SandboxLost. */
  close(): Promise<void>;
};

/** A digest of code. Not a key on its own: see `Keyed`. */
export function bundleHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// What every pool of this process does as the process ends: one listener for all of them.
const atExit = new Set<() => void>();
process.on('exit', () => {
  for (const kill of atExit) kill();
});

// The two scripts that run inside workerd are beside this package's code, as they were written.
const FILES = fileURLToPath(new URL('../../sandbox/', import.meta.url));

export async function createPool(options: PoolOptions = {}): Promise<Pool> {
  const maxRssMb = options.maxRssMb ?? 1024;
  const settings = {
    processes: options.processes ?? 2,
    probeMs: options.probeMs ?? 2000,
    stallMs: options.stallMs ?? 5000,
    maxRssMb,
    hardRssMb: options.hardRssMb ?? 1.5 * maxRssMb,
    maxBundles: options.maxBundles ?? Infinity,
    minRecycleMs: options.minRecycleMs ?? 60_000,
    idleRecycleMs: options.idleRecycleMs ?? 10 * 60_000,
    drainMs: options.drainMs ?? 30_000,
    maxAbandoned: options.maxAbandoned ?? 20,
    loadConcurrency: options.loadConcurrency ?? 2,
  };
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value !== 'number') continue;
    const least = ['minRecycleMs', 'idleRecycleMs', 'maxAbandoned'].includes(name) ? 0 : 1;
    if (!(value >= least)) throw new RangeError(`${name} must be ${least} or more`);
  }
  if (!existsSync(`${FILES}shim.js`)) throw new Error(`${FILES}shim.js is missing`);
  const network: Network = options.network ?? { reach: 'public' };
  const workerd = createRequire(import.meta.url)('workerd') as {
    readonly default: string;
    readonly compatibilityDate: string;
  };
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let closed = false;
  const lost: Record<LossKind | 'closed', number> = {
    stall: 0,
    exit: 0,
    connection: 0,
    drain: 0,
    closed: 0,
  };
  // A process over maxRssMb is replaced when it has no calls in flight, or after this.
  const SOFT_WAIT_MS = 10_000;

  class Slot {
    readonly index: number;
    current: Sandbox | undefined;
    /** The process that will be current: the first, a restart, or a replacement. */
    starting: Promise<Sandbox> | undefined;
    replacing: RecycleReason | undefined;
    readonly draining = new Set<Sandbox>();
    restarts = 0;
    readonly recycles: Record<RecycleReason, number> = {
      bundles: 0,
      rss: 0,
      abandoned: 0,
      idle: 0,
      inspect: 0,
    };
    readonly kills: Record<LossKind, number> = { stall: 0, exit: 0, connection: 0, drain: 0 };
    recycleTimes: number[] = [];
    lastRecycleAt = -Infinity;
    deferred = 0;
    lastDeferred: { readonly at: number; readonly reason: RecycleReason } | undefined;
    /** Since when the live process has been over maxRssMb. */
    overSince: number | undefined;
    /** Keys sent to this slot, and not forgotten. */
    assigned = 0;

    constructor(index: number) {
      this.index = index;
    }

    /** The live process, started when there is none. */
    sandbox(): Promise<Sandbox> {
      if (closed) return Promise.reject(new SandboxLost('the executor was closed'));
      if (this.current !== undefined && !this.current.gone) return Promise.resolve(this.current);
      return this.start();
    }

    /**
     * Starts the process that becomes current once it is ready. A process it
     * replaces takes calls until then, and drains after.
     */
    start(): Promise<Sandbox> {
      this.starting ??= Sandbox.start({
        binary: options.binary ?? workerd.default,
        files: FILES,
        network,
        compatibilityDate: workerd.compatibilityDate,
        loadConcurrency: settings.loadConcurrency,
        startTimeoutMs: 10_000,
        log,
        onLost: (sandbox, kind) => this.lost(sandbox, kind),
        onRejected: (kind, calls) => {
          lost[kind] += calls;
        },
      }).then(
        (sandbox) => {
          this.starting = undefined;
          const reason = this.replacing;
          this.replacing = undefined;
          if (closed) {
            sandbox.stop();
            return sandbox;
          }
          const old = this.current;
          this.current = sandbox;
          if (old !== undefined && !old.gone) {
            this.draining.add(old);
            old.drain(settings.drainMs, `recycled (${reason ?? 'replaced'})`);
          }
          return sandbox;
        },
        (error: unknown) => {
          this.starting = undefined;
          this.replacing = undefined;
          throw error;
        },
      );
      return this.starting;
    }

    lost(sandbox: Sandbox, kind: LossKind): void {
      this.kills[kind] += 1;
      if (this.draining.delete(sandbox) || this.current !== sandbox) return;
      this.current = undefined;
      this.restarts += 1;
      // Started now rather than by the next call, so that call does not wait for it.
      if (!closed) this.start().catch(() => {});
    }

    /**
     * Replaces the live process, unless one was replaced less than
     * `minRecycleMs` ago and `force` is not set: under steady demand for more
     * than a process holds, recycling only repeats, so it is put off and
     * reported. Whether a replacement is on its way.
     */
    recycle(reason: RecycleReason, force = false): boolean {
      if (this.starting !== undefined) return true;
      if (this.current === undefined || this.current.gone) return false;
      const now = Date.now();
      if (!force && now - this.lastRecycleAt < settings.minRecycleMs) {
        this.deferred += 1;
        this.lastDeferred = { at: now, reason };
        return false;
      }
      this.lastRecycleAt = now;
      this.recycleTimes = [...this.recycleTimes.filter((at) => now - at < 60_000), now];
      this.recycles[reason] += 1;
      this.restarts += 1;
      this.overSince = undefined;
      this.replacing = reason;
      this.start().catch((error: unknown) =>
        log(`a replacement workerd did not start: ${String(error)}`),
      );
      return true;
    }

    probe(): void {
      for (const sandbox of this.draining) {
        if (sandbox.gone) this.draining.delete(sandbox);
        else sandbox.probe(settings.stallMs);
      }
      const live = this.current;
      if (live === undefined || live.gone) return;
      live.probe(settings.stallMs);
      if (this.starting !== undefined || this.index < 0) return;
      const now = Date.now();
      if (live.rssMb > settings.hardRssMb) {
        this.recycle('rss', true);
      } else if (live.rssMb > settings.maxRssMb) {
        this.overSince ??= now;
        // Best when nothing is in flight; at the latest after a while.
        if (live.inFlight === 0 || now - this.overSince >= SOFT_WAIT_MS) this.recycle('rss');
      } else {
        this.overSince = undefined;
        if (live.abandoned > settings.maxAbandoned) this.recycle('abandoned', true);
        else if (
          live.inFlight === 0 &&
          live.bundles.size > 0 &&
          now - live.lastCallAt >= settings.idleRecycleMs &&
          live.rssMb > settings.maxRssMb / 2
        ) {
          this.recycle('idle');
        }
      }
    }

    processes(): Sandbox[] {
      return [
        ...(this.current === undefined || this.current.gone ? [] : [this.current]),
        ...[...this.draining].filter((sandbox) => !sandbox.gone),
      ];
    }

    /** What is wrong with this slot's capacity, if anything. */
    problem(): string | undefined {
      const now = Date.now();
      const minute = this.recycleTimes.filter((at) => now - at < 60_000).length;
      if (this.lastDeferred !== undefined && now - this.lastDeferred.at < settings.minRecycleMs) {
        return `slot ${this.index} wanted to recycle for ${this.lastDeferred.reason} within ${settings.minRecycleMs} ms of the last one (${this.deferred} times so far): more distinct bundles are in use than one process holds`;
      }
      if (minute > 1) return `slot ${this.index} recycled ${minute} times in the last minute`;
      return undefined;
    }
  }

  const slots = Array.from({ length: settings.processes }, (_, index) => new Slot(index));
  // `inspect` loads bundles in a process of its own, cleared when it has inspected a few, so
  // deploying does not fill the processes that run agents.
  const inspector = new Slot(-1);
  const INSPECTED = 20;
  // The first process of each slot, so a failure to start workerd is known now.
  await Promise.all(slots.map((slot) => slot.sandbox()));

  // Which slot each key goes to: sticky, since a bundle loaded twice costs twice.
  const assignments = new Map<string, { readonly slot: Slot; lastUsed: number }>();
  const FORGET_MS = 60 * 60_000;
  let pruned = Date.now();

  const all = (): Slot[] => [...slots, inspector];
  const watchdog = setInterval(() => {
    for (const slot of all()) slot.probe();
    const now = Date.now();
    if (now - pruned > 60_000) {
      pruned = now;
      for (const [id, assignment] of assignments) {
        if (now - assignment.lastUsed < FORGET_MS) continue;
        assignments.delete(id);
        assignment.slot.assigned -= 1;
      }
    }
  }, settings.probeMs);
  watchdog.unref();
  const killAll = (): void => {
    for (const slot of all()) for (const sandbox of slot.processes()) sandbox.stop();
  };
  atExit.add(killAll);

  /** The slot for a key: the one it went to before, or the one with the fewest keys. */
  const slotOf = (id: string): Slot => {
    const known = assignments.get(id);
    if (known !== undefined) {
      known.lastUsed = Date.now();
      return known.slot;
    }
    let best = slots[0] as Slot;
    for (const slot of slots) {
      const rss = (candidate: Slot): number => candidate.current?.rssMb ?? 0;
      if (
        slot.assigned < best.assigned ||
        (slot.assigned === best.assigned && rss(slot) < rss(best))
      ) {
        best = slot;
      }
    }
    best.assigned += 1;
    assignments.set(id, { slot: best, lastUsed: Date.now() });
    return best;
  };

  /**
   * Sends a request to the process of `slot` for module `id`, replaced first
   * when it would hold more than maxBundles, or has too many abandoned calls.
   * The count is checked and the request sent in one step, so calls at once
   * cannot overfill a process between them. While a replacement starts, the
   * old process takes calls for the bundles it holds; new bundles wait for it.
   */
  const send = async (
    slot: Slot,
    id: string,
    request: (sandbox: Sandbox) => Promise<Json>,
  ): Promise<Json> => {
    for (;;) {
      const sandbox = await slot.sandbox();
      if (sandbox.gone) continue;
      if (slot.current === sandbox && sandbox.abandoned > settings.maxAbandoned) {
        // Code still running there that nobody waits for: new calls wait for the replacement.
        slot.recycle('abandoned', true);
        const replacement = await slot.starting?.catch(() => undefined);
        if (replacement !== undefined && !replacement.gone) continue;
      }
      if (sandbox.bundles.has(id) || sandbox.bundles.size < settings.maxBundles) {
        return request(sandbox);
      }
      if (slot.starting === undefined && !slot.recycle('bundles')) {
        // Put off: over its count, rather than recycling in a loop.
        return request(sandbox);
      }
      const replacement = await slot.starting?.catch(() => undefined);
      if (replacement === undefined || replacement.gone) return request(sandbox);
    }
  };

  /**
   * Waits for a request's answer, giving it up when `signal` aborts. Called in the same step
   * the request is made, so no abort falls between the two. One that came while the request
   * was made, such as from inside `code()`, is seen right after the listener is on.
   */
  const awaited = async (request: Request, signal: AbortSignal | undefined): Promise<Json> => {
    const abort = (): void => {
      request.cancel(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
    try {
      return await request.result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };

  const host: Pool = {
    async inspect(code) {
      // A module of its own: inspecting never shares what a module keeps with an agent's calls.
      const id = moduleId(`inspect:${bundleHash(code)}`);
      return send(inspector, id, (sandbox) =>
        awaited(
          sandbox.request('inspect', id, () => Promise.resolve(code), {}),
          undefined,
        ),
      ).finally(() => {
        const live = inspector.current;
        if (live !== undefined && live.inFlight === 0 && live.bundles.size >= INSPECTED) {
          inspector.recycle('inspect', true);
        }
      });
    },

    async call(keyed, request) {
      const { signal } = request;
      // A call that was given up already never reaches a process.
      signal?.throwIfAborted();
      const id = moduleId(keyed.key);
      return send(slotOf(id), id, (sandbox) => {
        // Nor one given up while a process was started.
        signal?.throwIfAborted();
        return awaited(
          sandbox.request(
            'call',
            id,
            keyed.code,
            { path: request.path, argument: request.argument, context: request.context },
            request.secrets,
          ),
          signal,
        );
      });
    },

    forget(key) {
      const id = moduleId(key);
      const assignment = assignments.get(id);
      if (assignment === undefined) return;
      assignments.delete(id);
      assignment.slot.assigned -= 1;
    },

    stats() {
      const now = Date.now();
      const processes: ProcessStats[] = [];
      for (const slot of all()) {
        for (const sandbox of slot.processes()) {
          processes.push({
            slot: slot.index,
            pid: sandbox.pid,
            state: sandbox.draining ? 'draining' : 'live',
            bundles: sandbox.bundles.size,
            inFlight: sandbox.inFlight,
            abandoned: sandbox.abandoned,
            loading: sandbox.loading,
            queuedLoads: sandbox.queuedLoads,
            lastMessageAgeMs: now - sandbox.lastMessageAt,
            rssMb: Math.round(sandbox.rssMb),
            restarts: slot.restarts,
            recycles: { ...slot.recycles },
            kills: { ...slot.kills },
            recyclesLastMinute: slot.recycleTimes.filter((at) => now - at < 60_000).length,
            deferredRecycles: slot.deferred,
          });
        }
      }
      const problems = slots
        .map((slot) => slot.problem())
        .filter((problem) => problem !== undefined);
      return { processes, lost: { ...lost }, capacity: { ok: problems.length === 0, problems } };
    },

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      atExit.delete(killAll);
      await Promise.allSettled(all().map((slot) => slot.starting));
      killAll();
    },
  };
  processes.set(host, () =>
    slots.flatMap((slot) => [
      ...(slot.current === undefined ? [] : [slot.current]),
      ...slot.draining,
    ]),
  );
  return host;
}

const processes = new WeakMap<Pool, () => readonly Sandbox[]>();

/** The processes of a host, live and draining. For tests: not exported from the package. */
export function sandboxesOf(host: Pool): readonly Sandbox[] {
  return processes.get(host)?.() ?? [];
}
