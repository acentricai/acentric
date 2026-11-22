// A whole server from its settings: the database, the processes agents' code runs in, the
// engine and the API, each given to the next. And all of it stopped, in the order that loses
// nothing.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { builtInProviders } from '@acentric/ai';
import type { ModelRunner, Providers } from '@acentric/ai';
import { Accounts, Audit, Engine, Keys, People, Secrets, accountRunners } from '@acentric/core';
import type { EngineOptions, RunnerSource } from '@acentric/core';
import { IsolateExecutor } from '@acentric/executor';
import { docker } from '@acentric/sandbox';
import { FileBlobStore, SqliteStore } from '@acentric/store';

import { machinePrograms } from './downloads.ts';
import { startServer } from './serve.ts';
import type { Server } from './serve.ts';
import type { Settings } from './settings.ts';

export type Started = {
  readonly server: Server;
  /** The key of a server that had none, to be shown once. Undefined when it had a way in. */
  readonly firstKey: string | undefined;
  /**
   * For a server with no person yet: the link that makes its owner, to be shown once. A new
   * one is made each time such a server starts.
   */
  readonly setupLink: string | undefined;
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
    /** In place of the model accounts: what calls every actor's model. */
    readonly runner?: ModelRunner | RunnerSource;
    /** Lines the processes agents' code runs in write. To stderr without it. */
    readonly log?: (line: string) => void;
    readonly checkAnswers?: boolean;
    /** How hard a password's hash is to make (see `People`). Tests ask for less. */
    readonly passwordCost?: number;
    /** How long machines and their daemons are given, and the like. Tests ask for less. */
    readonly machines?: NonNullable<EngineOptions['machines']>;
    /** The providers sandboxes are made at, and the times they are kept by. For tests. */
    readonly sandboxes?: Partial<NonNullable<EngineOptions['sandboxes']>>;
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
  const programs = machinePrograms(settings.downloads);
  const audit = new Audit({ store });
  // A model is called with a model account, and with nothing else: no key is read from the
  // environment.
  const accounts = new Accounts({ store, secrets, providers, audit });
  const engine = new Engine({
    store,
    executor,
    providers,
    secrets,
    // The bytes of images and files, in a folder beside the database.
    blobs: new FileBlobStore(join(settings.data, 'blobs')),
    runner: more.runner ?? accountRunners(accounts),
    // The computers actors' commands run on: their daemons connect to this server. A daemon
    // is asked to take the machine program this server hands out, by its digest.
    machines: { build: programs.build, ...more.machines },
    // Machines the server makes itself, at the providers it was set up with.
    sandboxes: {
      providers: settings.docker === undefined ? [] : [docker(settings.docker)],
      ...(settings.publicUrl === undefined ? {} : { publicUrl: settings.publicUrl }),
      ...more.sandboxes,
    },
  });
  const people = new People({
    store,
    audit,
    ...(more.passwordCost === undefined ? {} : { passwordCost: more.passwordCost }),
  });
  const keys = new Keys({
    store,
    ...(settings.adminKey === undefined ? {} : { settingsKey: settings.adminKey }),
    agentOf: async (actor) => (await store.loadActor(actor))?.actor.agent,
    // A person's key does no more than the person may now.
    holderOf: (user) => people.holder(user),
  });

  try {
    const firstKey = await keys.first();
    const setupToken = await people.setupLink();
    // Before anything is kept: what a process that died left in the blob store is removed.
    await engine.blobs.sweep();
    const recovered = await engine.recover();
    const server = await startServer({
      engine,
      keys,
      people,
      audit,
      secrets,
      accounts,
      version: more.version,
      port: settings.port,
      host: settings.host,
      ...(more.checkAnswers === undefined ? {} : { checkAnswers: more.checkAnswers }),
      ...(settings.downloads === undefined
        ? {}
        : {
            downloads: {
              folder: settings.downloads,
              publicUrl: settings.publicUrl,
              machines: programs,
            },
          }),
    });
    return {
      server,
      firstKey,
      setupLink:
        setupToken === undefined
          ? undefined
          : linkOf(settings.publicUrl ?? server.url, 'setup', setupToken),
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

/** A link a person opens, to a page of the dashboard: it ends in what is used once. */
function linkOf(base: string, page: 'setup' | 'reset', token: string): string {
  return `${base}/${page}?token=${token}`;
}

/**
 * A link that sets a person's password again, made on the server itself: the way back in for
 * an owner who is locked out. It opens the database alone, so it is run beside a server that
 * is up as well as one that is not.
 */
export async function resetLink(
  settings: Settings,
  email: string,
): Promise<{ readonly link: string; readonly token: string; readonly expiresAt: number }> {
  const store = await SqliteStore.open(join(settings.data, 'engine.sqlite'));
  try {
    const people = new People({ store, audit: new Audit({ store }) });
    const { token, expiresAt } = await people.resetLinkFor(email);
    const base = settings.publicUrl ?? `http://${settings.host}:${String(settings.port)}`;
    return { link: linkOf(base, 'reset', token), token, expiresAt };
  } finally {
    await store.close();
  }
}
