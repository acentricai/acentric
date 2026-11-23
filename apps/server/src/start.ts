// A whole server from its settings: the database, the processes agents' code runs in, the
// engine and the API, each given to the next. And all of it stopped, in the order that loses
// nothing.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { builtInProviders } from '@acentric/ai';
import type { ModelRunner, Providers } from '@acentric/ai';
import { Accounts, Audit, Engine, Keys, People, Secrets, accountRunners } from '@acentric/core';
import type { EngineOptions, RunnerSource } from '@acentric/core';
import { IsolateExecutor } from '@acentric/executor';
import { boat, docker } from '@acentric/sandbox';
import { FileBlobStore, SCHEMA_VERSION, SqliteStore } from '@acentric/store';

import { DATABASE } from './backups/archive.ts';
import { lockData } from './backups/lock.ts';
import { Bucket } from './backups/bucket.ts';
import { Backups } from './backups/schedule.ts';

import { machinePrograms } from './downloads.ts';
import { startServer } from './serve.ts';
import { reseal, sealedKeys } from './sealed.ts';
import { holdPort } from './upgrading.ts';
import type { Holding } from './upgrading.ts';
import type { Server } from './serve.ts';
import type { Settings } from './settings.ts';

/** Where in the data a server that had no key writes the first one it made. */
export const FIRST_KEY_FILE = 'first-admin-key';

export type Started = {
  readonly server: Server;
  /**
   * The key of a server that had none, for its program to write to FIRST_KEY_FILE. Undefined
   * when it had a way in.
   */
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
    /** The schema this version's database is: the store's, but for tests of an upgrade. */
    readonly schema?: number;
  },
): Promise<Started> {
  await mkdir(settings.data, { recursive: true });
  // One server on a folder of data: a second, or a restore, is refused while this one runs.
  const lock = lockData(settings.data);
  // A database this version changes: its port says the server is upgrading meanwhile, until
  // the server itself takes it.
  let holding: Holding | undefined;
  const release = async () => {
    await holding?.close();
    holding = undefined;
  };
  try {
    const schema = schemaOf(join(settings.data, DATABASE));
    const current = more.schema ?? SCHEMA_VERSION;
    if (settings.port !== 0 && schema !== undefined && schema < current) {
      console.log(`upgrading the database to ${more.version}: the server answers once it has`);
      holding = await holdPort({ host: settings.host, port: settings.port, version: more.version });
    }
    await backUpBeforeUpgrade(settings, more.version, current);
  } catch (error) {
    await release();
    lock.release();
    throw error;
  }
  let store: SqliteStore;
  try {
    store = await SqliteStore.open(join(settings.data, DATABASE));
  } catch (error) {
    await release();
    lock.release();
    throw error;
  }
  for (const line of keysSaid(settings)) console.log(line);
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
      // Docker only where the server was told where Docker is. Boat always: an account at it
      // is added by its key, and sandboxes are made there once the server has its template.
      providers: [
        ...(settings.docker === undefined ? [] : [docker(settings.docker)]),
        boat(settings.boat),
      ],
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

  const backups =
    settings.backups === undefined
      ? undefined
      : new Backups({
          data: settings.data,
          dir: settings.backups.dir,
          everyMs: settings.backups.everyMs,
          keep: settings.backups.keep,
          version: more.version,
          // Blobs are kept as ever while one is taken, and none is removed.
          withoutRemovals: (work) => engine.blobs.withoutRemovals(work),
          audit,
          ...bucketOf(settings),
        });

  try {
    const firstKey = await keys.first();
    const setupToken = await people.setupLink();
    // Before anything is kept: what a process that died left in the blob store is removed.
    await engine.blobs.sweep();
    const recovered = await engine.recover();
    await release();
    const server = await startServer({
      engine,
      keys,
      people,
      audit,
      secrets,
      accounts,
      ...(backups === undefined ? {} : { backups }),
      version: more.version,
      port: settings.port,
      host: settings.host,
      ...(more.checkAnswers === undefined ? {} : { checkAnswers: more.checkAnswers }),
      ...(settings.dashboard === undefined ? {} : { dashboard: settings.dashboard }),
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
    await backups?.start();
    return {
      server,
      firstKey,
      setupLink:
        setupToken === undefined
          ? undefined
          : linkOf(settings.publicUrl ?? server.url, 'setup', setupToken),
      recovered,
      async close(options) {
        // No backup is started from now on, and one being taken is finished first.
        await backups?.close();
        await server.close(options);
        await executor.close();
        await store.close();
        lock.release();
      },
    };
  } catch (error) {
    await release();
    await backups?.close();
    await engine.close({ graceMs: 0 });
    await executor.close();
    await store.close();
    lock.release();
    throw error;
  }
}

/**
 * A backup of a database a new version is about to change, taken before it does: what a
 * person goes back to when the new version is not what they wanted. A database that is this
 * version's already, or that is not there yet, needs none.
 */
export async function backUpBeforeUpgrade(
  settings: Settings,
  version: string,
  /** The schema this version's database is: the store's, but for tests. */
  current: number = SCHEMA_VERSION,
): Promise<boolean> {
  if (settings.backups === undefined) return false;
  const schema = schemaOf(join(settings.data, DATABASE));
  if (schema === undefined || schema >= current) return false;
  console.log(`this version changes the database: backing it up first, to ${settings.backups.dir}`);
  const before = new Backups({
    data: settings.data,
    dir: settings.backups.dir,
    everyMs: settings.backups.everyMs,
    keep: settings.backups.keep,
    // Named for the version it was taken before upgrading to.
    version,
    // No server is running on it: nothing is removed meanwhile.
    withoutRemovals: (work) => work(),
    ...bucketOf(settings),
  });
  try {
    await before.take('before-upgrade');
    return true;
  } catch (error) {
    throw new Error(
      `the backup before this version changes the database failed, so it was not changed: ${error instanceof Error ? error.message : String(error)}. Make room in ${settings.backups.dir}, or set ACENTRIC_BACKUP_EVERY=off to start without one.`,
      { cause: error },
    );
  } finally {
    await before.close();
  }
}

/** The bucket backups are copied to as well, as the options of Backups. */
function bucketOf(settings: Settings): { bucket?: Bucket } {
  const place = settings.backups?.bucket;
  return place === undefined ? {} : { bucket: new Bucket(place) };
}

/**
 * What is sealed with which key, where that is news: values sealed with a key the server was not
 * given, which do not open; with an old key, which `reseal` seals again; and old keys that seal
 * nothing now, which may go.
 */
export function keysSaid(settings: Settings): string[] {
  const db = new DatabaseSync(join(settings.data, DATABASE), { readOnly: true });
  let counts: Map<string, number>;
  try {
    counts = sealedKeys(db);
  } finally {
    db.close();
  }
  const given = settings.secretKeys;
  const lines: string[] = [];
  for (const [id, count] of counts) {
    if (given?.keys[id] === undefined) {
      lines.push(
        `${String(count)} sealed values are sealed with the key ${id}, which this server was not given: they do not open. Give it in ACENTRIC_SECRET_KEYS_OLD.`,
      );
    } else if (id !== given.current) {
      lines.push(
        `${String(count)} sealed values are sealed with the old key ${id}: \`acentric-server reseal\`, with the server stopped, seals them with the current one, and then ${id} may be taken out of ACENTRIC_SECRET_KEYS_OLD.`,
      );
    }
  }
  for (const id of Object.keys(given?.keys ?? {})) {
    if (id !== given?.current && !counts.has(id)) {
      lines.push(
        `ACENTRIC_SECRET_KEYS_OLD has ${id}, which nothing is sealed with: it may be taken out.`,
      );
    }
  }
  return lines;
}

/**
 * Seals every sealed value of the data again with the current key, with no server running on
 * it, and says how many it sealed. A database of another version is refused: the server of
 * this one starts on it first.
 */
export function resealData(settings: Settings): number {
  if (settings.secretKeys === undefined) {
    throw new Error('ACENTRIC_SECRET_KEY is what values are sealed with again, and is not given');
  }
  const lock = lockData(settings.data);
  try {
    const path = join(settings.data, DATABASE);
    const schema = schemaOf(path);
    if (schema === undefined) throw new Error(`There is no database in ${settings.data}`);
    if (schema !== SCHEMA_VERSION) {
      throw new Error(
        `The database is at version ${String(schema)}, and this server's is ${String(SCHEMA_VERSION)}: start the server of this version on it first`,
      );
    }
    const db = new DatabaseSync(path);
    try {
      return reseal(db, settings.secretKeys);
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

/**
 * The schema of the database at `path`: undefined when there is none yet, or it has nothing in
 * it, as one that was never opened.
 */
function schemaOf(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  // Not read-only: a database a server stopped in the middle of leaves files to be read back.
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA query_only = ON');
    const { user_version: schema } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    return schema === 0 ? undefined : schema;
  } finally {
    db.close();
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
