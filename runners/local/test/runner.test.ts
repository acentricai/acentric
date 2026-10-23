// What the conformance scenarios leave to each runner: timers across
// restarts, the durable inbox, idempotent requests, handler host crashes,
// faults fixed by upgrading, deploying, subscriptions, unloading, shutdown.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Json, LogEntry } from '@acentric/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalRunner, RunnerError } from '../dist/index.js';
import type { InstanceEvent, LocalRunner, LocalRunnerOptions, Store } from '../dist/index.js';
import { SQLITE, STORES } from './stores.js';
import type { StoreKind } from './stores.js';

// A test agent, as the two modules a bundle holds. Input `ask` declares an
// effect; each effect's outcome is logged as a `result` entry. Version 1
// throws on results once sent `strict`; version 2 does not.
const agent = (version: string): string => `
export default {
  kinds: ['work', 'once', 'crash', 'crash_once', 'secret', '@timer'],
  init: () => ({ snapshot: { asks: [], strict: false } }),
  step: (state, message) => {
    const { snapshot } = state;
    if (message.type === 'input') {
      if (message.kind === 'ask') return { snapshot: { ...snapshot, asks: [...snapshot.asks, message.payload] } };
      if (message.kind === 'strict') return { snapshot: { ...snapshot, strict: true } };
      if (message.kind === 'note') return { snapshot, append: [{ kind: 'note', body: message.payload }] };
      return { error: 'unknown input ' + message.kind };
    }
    if (message.type === 'effect') {
      if (snapshot.strict && ${JSON.stringify(version)} === '1') throw new Error('no results wanted');
      return {
        snapshot: { ...snapshot, asks: snapshot.asks.filter((ask) => ask.key !== message.key) },
        append: [{ kind: 'result', body: { key: message.key, outcome: message.outcome } }],
      };
    }
    if (message.type === 'migrated') return { snapshot, append: [{ kind: 'migrated', body: { from: message.from } }] };
    return { snapshot };
  },
  effects: ({ snapshot }) => snapshot.asks.map((ask) => ({ key: ask.key, kind: ask.kind, args: ask.args ?? null })),
  view: ({ snapshot }) => ({ asks: snapshot.asks.length }),
};
`;

const handlers = `
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});
export default {
  work: { mode: 'reissue', run: async (ctx) => {
    ctx.emit('started');
    await sleep(ctx.args?.ms ?? 0, ctx.signal);
    return { attempt: ctx.attempt };
  } },
  once: { mode: 'once', run: async (ctx) => { await sleep(ctx.args?.ms ?? 0); return 'done'; } },
  crash: { mode: 'reissue', maxAttempts: 3, run: async (ctx) => {
    if (ctx.attempt < (ctx.args?.until ?? 99)) process.exit(1);
    return { attempt: ctx.attempt };
  } },
  crash_once: { mode: 'once', run: async () => process.exit(1) },
  secret: { mode: 'reissue', run: (ctx) => ctx.secrets.get('token') },
};
`;

const v1 = { name: 'tester', version: '1', agent: agent('1'), handlers };
const v2 = { name: 'tester', version: '2', agent: agent('2'), handlers };

type Setup = {
  runner: LocalRunner;
  store: Store;
  /** Kills the runner and its hosts, as a crash would, and starts a new one over the same store. */
  crash(): Promise<void>;
  /** Makes every commit fail while set, as if the process died just before it. */
  failCommits: boolean;
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

let storeKind: StoreKind = SQLITE;

async function setup(options: Partial<LocalRunnerOptions> = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-runner-'));
  const path = join(dir, 'store');
  let failCommits = false;

  const open = async (): Promise<{ runner: LocalRunner; store: Store }> => {
    const opened = await storeKind.open(path);
    const store = new Proxy(opened, {
      get: (target, property) => {
        if (property === 'commit' && failCommits)
          return () => Promise.reject(new Error('the process died'));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const runner = createLocalRunner({ store, codeDir: join(dir, 'code'), ...options });
    await runner.start();
    return { runner, store };
  };

  const state: Setup = {
    ...(await open()),
    get failCommits() {
      return failCommits;
    },
    set failCommits(value) {
      failCommits = value;
    },
    crash: async () => {
      state.runner.kill();
      await state.store.close();
      Object.assign(state, await open());
    },
  };
  cleanups.push(async () => {
    state.runner.kill();
    await state.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return state;
}

async function created(runner: LocalRunner, version = '1'): Promise<string> {
  const { id } = await runner.create({ name: 'tester', version }, {});
  if (id === undefined) throw new Error('not created');
  return id;
}

async function until(what: string, condition: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  // Waiting on handlers in other processes, a little at a time.
  // oxlint-disable-next-line no-await-in-loop
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const results = async (store: Store, id: string): Promise<Json[]> =>
  (await store.readLog(id, { kinds: ['result'] })).map((entry: LogEntry) => entry.body);

describe.each(STORES)('the local runner over $name', (kind) => {
  beforeEach(() => {
    storeKind = kind;
  });

  it('fires a timer, and one that came due while it was down', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 't1', kind: '@timer', args: { at: Date.now() + 30 } },
    });
    await until('the first timer', async () => (await results(s.store, id)).length === 1);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 't2', kind: '@timer', args: { at: Date.now() + 100 } },
    });
    await s.crash();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await until('the overdue timer', async () => (await results(s.store, id)).length === 2);
    expect(await results(s.store, id)).toEqual([
      { key: 't1', outcome: { ok: null } },
      { key: 't2', outcome: { ok: null } },
    ]);
  });

  it('keeps a result that arrived before a crash, so a once effect is not reported interrupted', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 'o', kind: 'once', args: { ms: 100 } },
    });
    s.failCommits = true;
    await until('the result in the inbox', async () => (await s.store.inbox(id)).length === 1);
    s.failCommits = false;
    await s.crash();
    await until('the result stepped', async () => (await results(s.store, id)).length === 1);
    expect(await results(s.store, id)).toEqual([{ key: 'o', outcome: { ok: 'done' } }]);
  });

  it('answers a retried input as the first time, without stepping it again', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    const input = { id: 'n1', kind: 'note', payload: { text: 'hi' } };
    expect(await s.runner.input(id, input)).toEqual({ accepted: true });
    await s.crash();
    expect(await s.runner.input(id, input)).toEqual({ accepted: true });
    expect(await s.store.readLog(id, { kinds: ['note'] })).toHaveLength(1);
    const refused = await s.runner
      .input(id, { ...input, payload: { text: 'other' } })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RunnerError);
    const rejection = { id: 'bad', kind: 'nope', payload: {} };
    expect(await s.runner.input(id, rejection)).toEqual({ rejected: 'unknown input nope' });
    expect(await s.runner.input(id, rejection)).toEqual({ rejected: 'unknown input nope' });
  });

  it('creates an instance once under a caller-chosen id', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const ref = { name: 'tester', version: '1' };
    expect(await s.runner.create(ref, {}, { id: 'mine' })).toEqual({ accepted: true, id: 'mine' });
    expect(await s.runner.create(ref, {}, { id: 'mine' })).toEqual({ accepted: true, id: 'mine' });
    await expect(s.runner.create(ref, { other: true }, { id: 'mine' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('runs a reissue effect again when its host crashes, and interrupts a once effect', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 'c', kind: 'crash', args: { until: 3 } },
    });
    await until('the third attempt', async () => (await results(s.store, id)).length === 1);
    expect(await results(s.store, id)).toEqual([{ key: 'c', outcome: { ok: { attempt: 3 } } }]);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 'x', kind: 'crash', args: { until: 9 } },
    });
    await s.runner.input(id, { kind: 'ask', payload: { key: 'y', kind: 'crash_once' } });
    await until('both reported', async () => (await results(s.store, id)).length === 3);
    expect((await results(s.store, id)).slice(1)).toEqual(
      expect.arrayContaining([
        { key: 'x', outcome: { failed: { code: 'attempts_exhausted', error: { attempts: 3 } } } },
        { key: 'y', outcome: { interrupted: true } },
      ]),
    );
  });

  it('clears a fault by upgrading, retrying the result that failed', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    await s.runner.deploy(v2);
    const id = await created(s.runner);
    await s.runner.input(id, { kind: 'strict', payload: {} });
    await s.runner.input(id, { kind: 'ask', payload: { key: 'w', kind: 'work' } });
    await until('the fault', async () => (await s.runner.get(id)).status === 'faulted');
    expect(await s.runner.input(id, { kind: 'note', payload: {} })).toMatchObject({
      failed: expect.anything(),
    });
    expect(await s.runner.upgrade(id, '2')).toEqual({ accepted: true });
    await until('the retried result', async () => (await results(s.store, id)).length === 1);
    expect(await results(s.store, id)).toEqual([{ key: 'w', outcome: { ok: { attempt: 1 } } }]);
    const info = await s.runner.get(id);
    expect(info).toMatchObject({ status: 'idle', fault: null, agent: { version: '2' } });
    expect((await s.store.readLog(id)).map((entry) => entry.kind)).toEqual(['migrated', 'result']);
  });

  it('deploys code once per version, and checks it', async () => {
    const s = await setup();
    expect((await s.runner.deploy(v1)).deployed).toBe(true);
    expect((await s.runner.deploy(v1)).deployed).toBe(false);
    await expect(s.runner.deploy({ ...v1, handlers: `${handlers}\n// changed` })).rejects.toThrow(
      /different code/,
    );
    await expect(
      s.runner.deploy({ ...v1, version: '3', handlers: 'export default {}' }),
    ).rejects.toThrow(/no handler for work, once, crash, crash_once, secret/);
    await expect(
      s.runner.deploy({
        ...v1,
        version: '4',
        handlers: "export default { '@timer': { mode: 'reissue', run: () => null } }",
      }),
    ).rejects.toThrow(/belong to runners/);
    await expect(
      s.runner.deploy({ ...v1, version: '5', agent: 'export default 1' }),
    ).rejects.toThrow(/init and step/);
    expect((await s.runner.listAgents()).map((a) => a.version)).toEqual(['1']);
  });

  it('gives handlers its secrets', async () => {
    const s = await setup({ secrets: { token: 'abc' } });
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, { kind: 'ask', payload: { key: 's', kind: 'secret' } });
    await until('the secret', async () => (await results(s.store, id)).length === 1);
    expect(await results(s.store, id)).toEqual([{ key: 's', outcome: { ok: 'abc' } }]);
  });

  it('tells a subscriber the history, then each step, emits and status', async () => {
    const s = await setup();
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, { kind: 'note', payload: { n: 1 } });
    const events: InstanceEvent[] = [];
    const stop = await s.runner.subscribe(id, { emits: true }, (event) => events.push(event));
    await s.runner.input(id, { kind: 'note', payload: { n: 2 } });
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 'w', kind: 'work', args: { ms: 20 } },
    });
    await until('the result', async () => (await results(s.store, id)).length === 1);
    await until('idle', () => {
      const last = events.at(-1);
      return Promise.resolve(last?.type === 'status' && last.status === 'idle');
    });
    stop();
    const seqs = events.flatMap((event) =>
      event.type === 'log' ? event.entries.map((entry) => entry.seq) : [],
    );
    expect(seqs).toEqual([1, 2, 3]);
    expect(events).toContainEqual({ type: 'emit', key: 'w', delta: 'started' });
    expect(events).toContainEqual({ type: 'view', view: { asks: 1 } });
    expect(events).toContainEqual({ type: 'status', status: 'busy', fault: null });
  });

  it('unloads idle instances and loads them again when needed', async () => {
    const s = await setup({ idleMs: 50 });
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 't', kind: '@timer', args: { at: Date.now() + 300 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await until(
      'the timer, after unloading',
      async () => (await results(s.store, id)).length === 1,
    );
    expect(await s.runner.input(id, { kind: 'note', payload: {} })).toEqual({ accepted: true });
  });

  it('lets running handlers finish within the grace period when closing', async () => {
    const s = await setup({ graceMs: 2000 });
    await s.runner.deploy(v1);
    const id = await created(s.runner);
    await s.runner.input(id, {
      kind: 'ask',
      payload: { key: 'o', kind: 'once', args: { ms: 200 } },
    });
    await s.runner.close();
    await s.crash();
    await until('the result', async () => (await results(s.store, id)).length === 1);
    expect(await results(s.store, id)).toEqual([{ key: 'o', outcome: { ok: 'done' } }]);
  });
});
