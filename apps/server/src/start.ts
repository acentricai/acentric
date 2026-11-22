// A whole server from its settings: the database, the processes agents' code runs in, the
// engine and the API, each given to the next. And all of it stopped, in the order that loses
// nothing.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { builtInProviders } from '@acentric/ai';
import type { ModelRunner, Providers } from '@acentric/ai';
import { Engine, Keys, Secrets, providerRunners } from '@acentric/core';
import type { RunnerSource } from '@acentric/core';
import { IsolateExecutor } from '@acentric/executor';
import { SqliteStore } from '@acentric/store';

import { startServer } from './serve.ts';
import type { Server } from './serve.ts';
import type { Settings } from './settings.ts';

export type Started = {
  readonly server: Server;
  /** The key of a server that had none, to be shown once. Undefined when it had a way in. */
  readonly firstKey: string | undefined;
  /** How many actors had something owed when the server started, and were picked up. */
  readonly recovered: number;
  /** Stops everything. What is in the middle of a turn stays owed, and is picked up next time. */
  close(options?: { readonly graceMs?: number }): Promise<void>;
};

export async function start(
  settings: Settings,
  more: {
    readonly version: string;
    /** In place of the providers there are: for a server that is to call no real model. */
    readonly providers?: Providers;
    readonly runner?: ModelRunner | RunnerSource;
    /** Lines the processes agents' code runs in write. To stderr without it. */
    readonly log?: (line: string) => void;
    readonly checkAnswers?: boolean;
  },
): Promise<Started> {
  await mkdir(settings.data, { recursive: true });
  const store = await SqliteStore.open(join(settings.data, 'engine.sqlite'));
  const secrets = new Secrets({
    store,
    ...(settings.secretKeys === undefined ? {} : { keys: settings.secretKeys }),
  });
  const executor = await IsolateExecutor.start({
    network: settings.network,
    processes: settings.codeProcesses,
    secrets: (agent, name) => secrets.get(agent, name),
    ...(more.log === undefined ? {} : { log: more.log }),
  });
  const providers = more.providers ?? builtInProviders();
  const engine = new Engine({
    store,
    executor,
    providers,
    secrets,
    runner: more.runner ?? providerRunners(providers, (id) => settings.credentials[id]),
  });
  const keys = new Keys({
    store,
    ...(settings.adminKey === undefined ? {} : { settingsKey: settings.adminKey }),
    agentOf: async (actor) => (await store.loadActor(actor))?.actor.agent,
  });

  try {
    const firstKey = await keys.first();
    const recovered = await engine.recover();
    const server = await startServer({
      engine,
      keys,
      secrets,
      version: more.version,
      port: settings.port,
      host: settings.host,
      ...(more.checkAnswers === undefined ? {} : { checkAnswers: more.checkAnswers }),
    });
    return {
      server,
      firstKey,
      recovered,
      async close(options) {
        await server.close(options);
        await executor.close();
        await store.close();
      },
    };
  } catch (error) {
    await engine.close({ graceMs: 0 });
    await executor.close();
    await store.close();
    throw error;
  }
}
