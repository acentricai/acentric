// A whole server from its settings: the database, the processes agents' code runs in, the
// engine and the API, each given to the next. And all of it stopped, in the order that loses
// nothing.

import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { builtInProviders } from '@acentric/ai';
import type { ModelRunner, Providers } from '@acentric/ai';
import type { AccountId } from '@acentric/protocol';
import {
  Accounts,
  SignIns,
  Audit,
  Engine,
  Keys,
  People,
  Secrets,
  accountRunners,
  openWith,
} from '@acentric/core';
import type { EngineOptions, RunnerSource } from '@acentric/core';
import { fetchWithin, IsolateExecutor } from '@acentric/executor';
import { boat, docker } from '@acentric/sandbox';
import { FileBlobStore, readBackupSettings, SCHEMA_VERSION, SqliteStore } from '@acentric/store';

import { DATABASE } from './backups/archive.ts';
import { lockData } from './backups/lock.ts';
import { Bucket } from './backups/bucket.ts';
import { Backups } from './backups/schedule.ts';
import { BackupControl, fromEnvironment, fromStored, openBucketSecret } from './backups/control.ts';
import type { Effective } from './backups/control.ts';

import { machinePrograms } from './downloads.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import { Metrics, serveMetrics } from './metrics.ts';
import { observing } from './observe.ts';
import { Retention } from './retention.ts';
import { startServer } from './serve.ts';
import { UpdateCheck } from './updates.ts';
import { UpdaterFolder } from './updater.ts';
import { reseal, sealedKeys } from './sealed.ts';
import { holdPort } from './upgrading.ts';
import type { Holding } from './upgrading.ts';
import type { Server } from './serve.ts';
import type { Settings } from './settings.ts';

/**
 * How long a server told to stop goes on answering, once /health says it is stopping: for
 * what is in front to see that, and send requests elsewhere.
 */
export const DRAIN_MS = 3_000;

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
  /** Where the metrics are, when the server serves them. */
  readonly metricsUrl: string | undefined;
  /** What removes what has had its day, every hour: run now, for tests. */
  readonly retention: Retention;
  /**
   * Says, at /health, that the server takes no more requests, ahead of `close`: for what is in
   * front to send them elsewhere first.
   */
  drain(): void;
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
    /**
     * Where each line of the server's log goes, as its settings say to write it: stdout, and
     * stderr for warnings and errors, without it. Tests give one that keeps them.
     */
    readonly log?: (line: string) => void;
    /** The server's log, in place of the one its settings and `log` make. */
    readonly logger?: Logger;
    readonly checkAnswers?: boolean;
    /** How hard a password's hash is to make (see `People`). Tests ask for less. */
    readonly passwordCost?: number;
    /** How long machines and their daemons are given, and the like. Tests ask for less. */
    readonly machines?: NonNullable<EngineOptions['machines']>;
    /** The providers sandboxes are made at, and the times they are kept by. For tests. */
    readonly sandboxes?: Partial<NonNullable<EngineOptions['sandboxes']>>;
    /** The schema this version's database is: the store's, but for tests of an upgrade. */
    readonly schema?: number;
    /** What the audit log, and removing old data, tell the time by. For tests. */
    readonly clock?: () => number;
  },
): Promise<Started> {
  const write = more.log;
  const logger =
    more.logger ??
    createLogger({
      ...settings.log,
      ...(write === undefined ? {} : { write: (line) => write(line) }),
    });
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
      logger.info(`upgrading the database to ${more.version}: the server answers once it has`);
      holding = await holdPort({
        host: settings.host,
        port: settings.port,
        version: more.version,
        ...(settings.dashboard === undefined ? {} : { dashboard: settings.dashboard }),
      });
    }
    await backUpBeforeUpgrade(settings, more.version, current, logger);
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
  for (const line of keysSaid(settings)) logger.warn(line);
  const unused = spaceSaid(settings);
  if (unused !== undefined) logger.info(unused);
  const metrics = settings.metricsPort === undefined ? undefined : new Metrics(more.version);
  const told = observing(logger, metrics);
  const secrets = new Secrets({
    store,
    ...(settings.secretKeys === undefined ? {} : { keys: settings.secretKeys }),
  });
  const executor = await IsolateExecutor.start({
    network: settings.network,
    processes: settings.codeProcesses,
    secrets: (agent, name) => secrets.get(agent, name),
    log: (line) => logger.warn(line, { from: 'workerd' }),
  });
  const providers =
    more.providers ??
    builtInProviders(
      settings.anthropicUrl === undefined ? {} : { anthropicUrl: settings.anthropicUrl },
    );
  const programs = machinePrograms(settings.downloads);
  const audit = new Audit({
    store,
    ...(more.clock === undefined ? {} : { clock: more.clock }),
    report: (error) => logger.error('the audit log could not be written to', {}, error),
  });
  // A model is called with a model account, and with nothing else: no key is read from the
  // environment.
  const accounts = new Accounts({ store, secrets, providers, audit });
  const signIns = new SignIns({ store, providers, accounts });
  const engine = new Engine({
    store,
    executor,
    providers,
    secrets,
    // The bytes of images and files, in a folder beside the database.
    blobs: new FileBlobStore(join(settings.data, 'blobs')),
    runner: more.runner ?? accountRunners(accounts),
    // Each actor is given an account of its agent's provider when it is created: what its
    // calls are made with. A runner given in place of the accounts calls without one.
    ...(more.runner === undefined
      ? { accountOf: (provider: string, wanted?: AccountId) => accounts.choose(provider, wanted) }
      : {}),
    // The computers actors' commands run on: their daemons connect to this server. A daemon
    // is asked to take the machine program this server hands out, by its digest.
    machines: { build: programs.build, ...more.machines },
    // An agent's MCP servers are reached from this process: as far as its code may reach.
    mcp: { fetch: fetchWithin(settings.network) },
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
    maxConcurrentTurns: settings.maxTurns,
    // What an actor, a machine, a task or a sandbox could not go on from.
    report: (error) => logger.error('the engine failed at something', {}, error),
    observer: told.observer,
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

  // The environment's backup settings until others are set through the API.
  const backups = new BackupControl({
    store,
    secrets,
    audit,
    dir: settings.backupDir,
    env: settings.backups,
    make: (effective) =>
      new Backups({
        data: settings.data,
        dir: settings.backupDir,
        everyMs: effective.everyMs,
        keep: effective.keep,
        version: more.version,
        // Blobs are kept as ever while one is taken, and none is removed.
        withoutRemovals: (work) => engine.blobs.withoutRemovals(work),
        audit,
        log: (line) => logger.info(line),
        ...bucketOf(effective),
      }),
    log: (line) => logger.info(line),
  });

  const retention = new Retention({
    engine,
    store,
    audit,
    logger,
    metrics,
    settings: settings.retention,
    ...(more.clock === undefined ? {} : { clock: more.clock }),
  });

  let draining = false;
  let metricsServer: Awaited<ReturnType<typeof serveMetrics>> | undefined;
  try {
    const firstKey = await keys.first();
    const setupToken = await people.setupLink();
    // Before anything is kept: what a process that died left in the blob store is removed.
    await engine.blobs.sweep();
    const recovered = await engine.recover();
    await backups.load();
    await release();
    const server = await startServer({
      engine,
      keys,
      people,
      audit,
      secrets,
      accounts,
      signIns,
      backups,
      updates: new UpdateCheck({ version: more.version, enabled: settings.updateCheck }),
      ...(settings.updaterDir === undefined
        ? {}
        : { updater: new UpdaterFolder(settings.updaterDir) }),
      version: more.version,
      port: settings.port,
      host: settings.host,
      report: (error, requestId) => logger.error('a request failed', { requestId }, error),
      answered: told.answered,
      ready: async () => {
        const problems: string[] = [];
        if (draining) problems.push('it is stopping');
        try {
          // A query of each of the database's threads, the writer's and the reader's: that
          // each answers at all.
          await Promise.all([
            store.secretNames('agt_ready' as never),
            store.listAgents({ limit: 1 }),
          ]);
        } catch (error) {
          problems.push(
            `its database does not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!executor.stats().processes.some((one) => one.state === 'live')) {
          problems.push("no process runs agents' code");
        }
        return problems;
      },
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
    await backups.start();
    retention.start();
    if (metrics !== undefined && settings.metricsPort !== undefined) {
      gaugesOf(metrics, {
        data: settings.data,
        working: told.working,
        streams: server.streams,
        connected: () => engine.machines?.connected ?? 0,
        load: () => engine.load,
        executor,
        backups,
      });
      metricsServer = await serveMetrics(metrics, settings.host, settings.metricsPort);
    }
    return {
      server,
      firstKey,
      metricsUrl: metricsServer?.url,
      retention,
      drain() {
        draining = true;
      },
      setupLink:
        setupToken === undefined
          ? undefined
          : linkOf(settings.publicUrl ?? server.url, 'setup', setupToken),
      recovered,
      async close(options) {
        // No backup is started from now on, and one being taken is finished first.
        draining = true;
        await retention.close();
        await backups.close();
        await server.close(options);
        await metricsServer?.close();
        metrics?.close();
        await executor.close();
        await store.close();
        lock.release();
      },
    };
  } catch (error) {
    await release();
    await retention.close();
    await metricsServer?.close();
    metrics?.close();
    await backups.close();
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
  logger: Logger = createLogger(settings.log),
): Promise<boolean> {
  const schema = schemaOf(join(settings.data, DATABASE));
  if (schema === undefined || schema >= current) return false;
  // As set through the API, when they were: those win over the environment's.
  const effective = backupsOf(settings, logger);
  if (!effective.enabled) return false;
  logger.info(`this version changes the database: backing it up first, to ${settings.backupDir}`);
  const before = new Backups({
    data: settings.data,
    dir: settings.backupDir,
    everyMs: effective.everyMs,
    keep: effective.keep,
    // Named for the version it was taken before upgrading to.
    version,
    // No server is running on it: nothing is removed meanwhile.
    withoutRemovals: (work) => work(),
    log: (line) => logger.info(line),
    ...bucketOf(effective),
  });
  try {
    await before.take('before-upgrade');
    return true;
  } catch (error) {
    throw new Error(
      `the backup before this version changes the database failed, so it was not changed: ${error instanceof Error ? error.message : String(error)}. Make room in ${settings.backupDir}, or turn backups off to start without one.`,
      { cause: error },
    );
  } finally {
    await before.close();
  }
}

/** The bucket backups are copied to as well, as the options of Backups. */
function bucketOf(effective: Effective): { bucket?: Bucket } {
  const { bucket } = effective;
  return bucket === undefined ? {} : { bucket: new Bucket(bucket.place, bucket.credentials) };
}

/**
 * How the server backs itself up, read from the database with no server running on it: those
 * set through the API, or the environment's.
 */
function backupsOf(settings: Settings, logger: Logger): Effective {
  const path = join(settings.data, DATABASE);
  const db = new DatabaseSync(path);
  let stored;
  try {
    db.exec('PRAGMA query_only = ON');
    stored = readBackupSettings(db);
  } finally {
    db.close();
  }
  if (stored === undefined) return fromEnvironment(settings.backups);
  const keys = settings.secretKeys;
  try {
    return fromStored(stored, (sealed) => {
      if (keys === undefined) throw new Error('ACENTRIC_SECRET_KEY is not given');
      return openBucketSecret({
        open: (bound, value, what) => openWith(keys, bound, value, what),
      })(sealed);
    });
  } catch (error) {
    logger.warn(
      `the backup is not copied to ${stored.bucket?.url ?? 'the bucket'}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return fromStored({ ...stored, bucket: null }, () => '');
  }
}

/** The metrics read when they are asked for: what is so now, rather than what happened. */
function gaugesOf(
  metrics: Metrics,
  parts: {
    readonly data: string;
    readonly working: () => number;
    readonly streams: () => number;
    readonly connected: () => number;
    readonly load: () => Engine['load'];
    readonly executor: IsolateExecutor;
    readonly backups: BackupControl;
  },
): void {
  const one = (value: number) => [{ value }];
  metrics.gauge('acentric_actors_working', 'Actors of this server in a turn now.', () =>
    one(parts.working()),
  );
  metrics.gauge(
    'acentric_turns_running',
    'Turns going on now, and the most there are at once (max): the rest wait.',
    () => {
      const { turns, maxTurns } = parts.load();
      return [{ value: turns }, { labels: { of: 'max' }, value: maxTurns }];
    },
  );
  metrics.gauge('acentric_turns_waiting', 'Turns that wait for one going on to end.', () =>
    one(parts.load().waiting),
  );
  metrics.gauge(
    'acentric_actors_in_memory',
    'Actors kept in memory between turns, and the most that are (max).',
    () => {
      const { hot, maxHot } = parts.load();
      return [{ value: hot }, { labels: { of: 'max' }, value: maxHot }];
    },
  );
  metrics.gauge('acentric_event_streams_open', "Actors' event streams open now.", () =>
    one(parts.streams()),
  );
  metrics.gauge('acentric_machines_connected', "Machines' daemons connected now.", () =>
    one(parts.connected()),
  );
  metrics.gauge('acentric_code_processes', "Processes that run agents' code, by state.", () => {
    const { processes } = parts.executor.stats();
    return ['live', 'draining'].map((state) => ({
      labels: { state },
      value: processes.filter((process) => process.state === state).length,
    }));
  });
  metrics.gauge(
    'acentric_code_process_restarts',
    "How many times the processes that run agents' code were replaced, since the server started.",
    () => {
      const slots = new Map<number, number>();
      for (const process of parts.executor.stats().processes)
        slots.set(process.slot, process.restarts);
      return one([...slots.values()].reduce((sum, restarts) => sum + restarts, 0));
    },
  );
  const sizeOf = (path: string) => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  metrics.gauge('acentric_database_bytes', 'The database, and its write-ahead log.', () => [
    { labels: { file: 'database' }, value: sizeOf(join(parts.data, DATABASE)) },
    { labels: { file: 'wal' }, value: sizeOf(join(parts.data, `${DATABASE}-wal`)) },
  ]);
  // The blobs are counted again at most every five minutes: there may be many.
  const blobs = { bytes: 0, count: 0, at: 0, counting: false };
  const countBlobs = async () => {
    blobs.counting = true;
    let bytes = 0;
    let count = 0;
    try {
      for (const entry of await readdir(join(parts.data, 'blobs'), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        bytes += (await stat(join(entry.parentPath, entry.name)).catch(() => undefined))?.size ?? 0;
        count += 1;
      }
      Object.assign(blobs, { bytes, count, at: Date.now() });
    } catch {
      // A folder that is not there yet has none.
    } finally {
      blobs.counting = false;
    }
  };
  void countBlobs();
  metrics.gauge(
    'acentric_blobs',
    "Conversations' images and files: how many, and their bytes.",
    () => {
      if (!blobs.counting && Date.now() - blobs.at > 300_000) void countBlobs();
      return [
        { labels: { of: 'count' }, value: blobs.count },
        { labels: { of: 'bytes' }, value: blobs.bytes },
      ];
    },
  );
  // Of the backups taken now: none while they are off.
  const { backups } = parts;
  metrics.gauge(
    'acentric_backup_newest_timestamp_seconds',
    'When the newest backup in the folder was taken, in seconds since 1970.',
    () => {
      const newest = backups.current?.newestAt;
      return newest === undefined ? [] : one(newest / 1000);
    },
  );
  metrics.gauge('acentric_backup_failures', 'Backups that failed since the server started.', () => {
    const current = backups.current;
    return current === undefined ? [] : one(current.failures);
  });
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

/** What a database file has in it: its size, what of it is unused, and whether it gives that back. */
function spaceOf(path: string): { bytes: number; unused: number; givesBack: boolean } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const read = (pragma: string) =>
      Object.values(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[0] ?? 0;
    const page = read('page_size');
    return {
      bytes: read('page_count') * page,
      unused: read('freelist_count') * page,
      givesBack: read('auto_vacuum') === 2,
    };
  } finally {
    db.close();
  }
}

/**
 * Said as the server starts, of a database made before it gave back what is removed, with a
 * good part of it unused: that `compact` gives it back. Undefined otherwise.
 */
export function spaceSaid(settings: Settings): string | undefined {
  const path = join(settings.data, DATABASE);
  if (!existsSync(path)) return undefined;
  const { bytes, unused, givesBack } = spaceOf(path);
  if (givesBack || unused < 64 * 1_048_576 || unused < bytes / 5) return undefined;
  return `the database has ${String(Math.round(unused / 1_048_576))} MB it does not use, of ${String(Math.round(bytes / 1_048_576))} MB: \`acentric-server compact\`, with the server stopped, gives it back to the disk, and has the database give back what is removed from then on`;
}

/**
 * Vacuums the database with no server running on it: what it does not use is given back to the
 * disk, and from then on what is removed is given back as it goes. It writes a copy as large as
 * the database as it does, and is refused without room for that. Gives the bytes before and
 * after.
 */
export async function compactData(
  settings: Settings,
): Promise<{ readonly before: number; readonly after: number }> {
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
    const before = spaceOf(path);
    const free = await statfs(settings.data);
    if (free.bavail * free.bsize < before.bytes * 1.1) {
      throw new Error(
        `${settings.data} has ${String(Math.floor((free.bavail * free.bsize) / 1_048_576))} MB free, and compacting needs about ${String(Math.ceil((before.bytes * 1.1) / 1_048_576))} MB`,
      );
    }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
    } finally {
      db.close();
    }
    return { before: before.bytes, after: spaceOf(path).bytes };
  } finally {
    lock.release();
  }
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
