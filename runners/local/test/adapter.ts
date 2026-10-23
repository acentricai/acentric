// The local runner's conformance adapter. Each scenario gets its own SQLite
// store. A crash kills the runner and its handler hosts, closes the store and
// opens a new runner over it. The probe's gates are served to the hosts over
// a local socket.

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { serveGates } from '@acentric/conformance';
import type { Adapter, Answer } from '@acentric/conformance';
import type { Json, LogEntry } from '@acentric/types';

import { createLocalRunner } from '../dist/index.js';
import type { LocalRunner, Store } from '../dist/index.js';
import { probeBundles } from './bundles.js';
import { SQLITE } from './stores.js';
import type { StoreKind } from './stores.js';

const remoteHook = pathToFileURL(
  createRequire(import.meta.url).resolve('@acentric/conformance/remote-hook'),
).href;

async function answerOf(work: () => Promise<Answer>): Promise<Answer> {
  try {
    return await work();
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

export async function localAdapter(storeKind: StoreKind = SQLITE): Promise<Adapter> {
  const gates = await serveGates();
  const dir = await mkdtemp(join(tmpdir(), 'acentric-local-'));
  const path = join(dir, 'store');
  const probes = await probeBundles();
  const emitted = new Map<string, Json[]>();
  let id: string | null = null;
  let stopListening: (() => void) | null = null;

  const open = async (store: Store): Promise<LocalRunner> => {
    const runner = createLocalRunner({
      store,
      codeDir: join(dir, 'code'),
      host: { execArgv: ['--import', remoteHook], env: gates.env },
    });
    await runner.start();
    return runner;
  };

  let store = await storeKind.open(path);
  let runner = await open(store);
  await runner.deploy({ name: 'probe', version: '1', agent: probes.v1, handlers: probes.handlers });
  await runner.deploy({ name: 'probe', version: '2', agent: probes.v2, handlers: probes.handlers });

  const listen = async (): Promise<void> => {
    if (id === null) return;
    stopListening = await runner.subscribe(
      id,
      { after: Number.MAX_SAFE_INTEGER, emits: true },
      (event) => {
        if (event.type === 'emit')
          emitted.set(event.key, [...(emitted.get(event.key) ?? []), event.delta]);
      },
    );
  };

  const session = (): string => {
    if (id === null) throw new Error('no session has been created');
    return id;
  };

  /** Whether the session has work, other than gates waiting to be released. */
  const busy = async (): Promise<boolean> => {
    if (id === null) return false;
    const info = await runner.get(id);
    const waiting = gates.waiting();
    return (
      info.working || info.running.some((effect) => effect.active && !waiting.includes(effect.key))
    );
  };

  return {
    supports: ['durable', 'upgrade'],
    create: async (bundle, config) => {
      if (bundle === 'probe-bad-handler-name') {
        try {
          await runner.deploy({
            name: 'probe-bad',
            version: '1',
            agent: probes.v1,
            handlers: probes.badHandlers,
          });
        } catch (error) {
          return { rejected: error instanceof Error ? error.message : 'refused' };
        }
      }
      const { id: created, ...answer } = await runner.create(
        { name: 'probe', version: '1' },
        config,
      );
      if (created !== undefined) {
        id = created;
        await listen();
      }
      return answer;
    },
    input: (kind, payload) => answerOf(() => runner.input(session(), { kind, payload })),
    configure: (config) => answerOf(() => runner.configure(session(), config)),
    release: (key, outcome) => {
      gates.release(key, outcome);
      return Promise.resolve();
    },
    settle: async () => {
      const deadline = Date.now() + 10_000;
      // Signals and results cross process boundaries, so the runner counts as
      // settled once it has stayed quiet for a moment.
      for (let quiet = 0; quiet < 2;) {
        if (Date.now() > deadline) throw new Error('the runner did not settle within 10 seconds');
        // Settling waits on handlers in other processes, a little at a time.
        // oxlint-disable-next-line no-await-in-loop
        quiet = (await busy()) ? 0 : quiet + 1;
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    running: async () =>
      id === null
        ? []
        : (await runner.get(id)).running.map(({ key, kind, args, attempt, abort }) => ({
            key,
            kind,
            args,
            attempt,
            abort,
          })),
    signalled: () => Promise.resolve(gates.signalled()),
    log: async (): Promise<LogEntry[]> => (id === null ? [] : store.readLog(id)),
    snapshot: async () => (id === null ? {} : ((await store.load(id))?.snapshot ?? {})),
    emitted: (key) => Promise.resolve(emitted.get(key) ?? []),
    crash: async () => {
      stopListening?.();
      runner.kill();
      await store.close();
      store = await storeKind.open(path);
      runner = await open(store);
      await listen();
    },
    upgrade: () => answerOf(() => runner.upgrade(session(), '2')),
    close: async () => {
      stopListening?.();
      runner.kill();
      await store.close();
      await gates.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
