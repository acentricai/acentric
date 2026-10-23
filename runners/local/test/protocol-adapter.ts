// The conformance adapter that drives the local runner through the
// protocol: the runner is a child process, spoken to over stdio by
// @acentric/client, and a crash is SIGKILL of that process. Handler hosts
// load the remote gate hook.

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnRunner } from '@acentric/client/node';
import type { RunnerClient, SpawnedRunner, Subscription } from '@acentric/client/node';
import { serveGates } from '@acentric/conformance';
import type { Adapter, Answer } from '@acentric/conformance';
import type { Json, LogEntry } from '@acentric/types';

import { probeBundles } from './bundles.js';
import { SQLITE } from './stores.js';
import type { StoreKind } from './stores.js';

export const RUNNER_BIN = fileURLToPath(new URL('../dist/server/bin.js', import.meta.url));
const REMOTE_HOOK = createRequire(import.meta.url).resolve('@acentric/conformance/remote-hook');

async function answerOf(work: () => Promise<Answer>): Promise<Answer> {
  try {
    return await work();
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

export async function protocolAdapter(storeKind: StoreKind = SQLITE): Promise<Adapter> {
  const gates = await serveGates();
  const dir = await mkdtemp(join(tmpdir(), 'acentric-protocol-'));
  const probes = await probeBundles();
  const emitted = new Map<string, Json[]>();
  let id: string | null = null;
  let subscription: Subscription | null = null;

  const start = (): Promise<SpawnedRunner> =>
    spawnRunner({
      store: storeKind.spec(join(dir, 'store')),
      command: process.execPath,
      args: [RUNNER_BIN],
      runnerArgs: ['--code-dir', join(dir, 'code'), '--host-import', REMOTE_HOOK],
      env: { ...process.env, ...gates.env },
      name: 'conformance',
    });

  let runner = await start();
  const client = (): RunnerClient => runner.client;
  await client().deploy({
    name: 'probe',
    version: '1',
    agent: probes.v1,
    handlers: probes.handlers,
  });
  await client().deploy({
    name: 'probe',
    version: '2',
    agent: probes.v2,
    handlers: probes.handlers,
  });

  const listen = async (): Promise<void> => {
    if (id === null) return;
    subscription = await client().subscribe(
      id,
      { after: Number.MAX_SAFE_INTEGER, emits: true },
      (event) => {
        if (event.type === 'emit')
          emitted.set(event.key, [...(emitted.get(event.key) ?? []), event.delta]);
      },
    );
  };

  const instance = (): string => {
    if (id === null) throw new Error('no instance has been created');
    return id;
  };

  const busy = async (): Promise<boolean> => {
    if (id === null) return false;
    const info = await client().get(id);
    const waiting = gates.waiting();
    return (
      info.working || info.running.some((effect) => effect.active && !waiting.includes(effect.key))
    );
  };

  const readLog = async (after = 0): Promise<LogEntry[]> => {
    const page = await client().log(instance(), { after });
    const last = page.entries.at(-1);
    if (page.cursor === undefined || last === undefined) return page.entries;
    return [...page.entries, ...(await readLog(last.seq))];
  };

  return {
    supports: ['durable', 'upgrade'],
    create: async (bundle, config) => {
      if (bundle === 'probe-bad-handler-name') {
        try {
          await client().deploy({
            name: 'probe-bad',
            version: '1',
            agent: probes.v1,
            handlers: probes.badHandlers,
          });
        } catch (error) {
          return { rejected: error instanceof Error ? error.message : 'refused' };
        }
      }
      const { id: created, ...answer } = await client().create('probe@1', config);
      if (created !== undefined) {
        id = created;
        await listen();
      }
      return answer;
    },
    input: (kind, payload) => answerOf(() => client().input(instance(), { kind, payload })),
    configure: (config) => answerOf(() => client().configure(instance(), config)),
    release: (key, outcome) => {
      gates.release(key, outcome);
      return Promise.resolve();
    },
    settle: async () => {
      const deadline = Date.now() + 10_000;
      for (let quiet = 0; quiet < 2;) {
        if (Date.now() > deadline) throw new Error('the runner did not settle within 10 seconds');
        // Settling waits on another process, a little at a time.
        // oxlint-disable-next-line no-await-in-loop
        quiet = (await busy()) ? 0 : quiet + 1;
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    running: async () =>
      id === null
        ? []
        : (await client().get(id)).running.map(({ key, kind, args, attempt, abort }) => ({
            key,
            kind,
            args,
            attempt,
            abort,
          })),
    signalled: () => Promise.resolve(gates.signalled()),
    log: async () => (id === null ? [] : readLog()),
    snapshot: async () =>
      id === null ? {} : ((await client().get(id, { snapshot: true })).snapshot ?? {}),
    emitted: (key) => Promise.resolve(emitted.get(key) ?? []),
    crash: async () => {
      runner.process.kill('SIGKILL');
      await runner.exited;
      runner = await start();
      await listen();
    },
    upgrade: () => answerOf(() => client().upgrade(instance(), '2')),
    close: async () => {
      await subscription?.close().catch(() => undefined);
      runner.process.kill('SIGKILL');
      await runner.exited;
      await gates.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
