#!/usr/bin/env node
// The server's program. It reads its settings from the environment (see `settings.ts`),
// starts, and says where it listens. Told to stop, it finishes what it is in the middle of.

import { chmodSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

import { checkBackup, restore } from './backups/archive.ts';
import { readObject } from './backups/bucket.ts';
import { backupTo } from './backups/command.ts';

import { InvalidSettings, readSettings } from './settings.ts';
import { createLogger } from './log.ts';
import {
  DRAIN_MS,
  FIRST_KEY_FILE,
  compactData,
  keysSaid,
  resealData,
  resetLink,
  start,
} from './start.ts';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

if (process.argv.includes('--version')) {
  console.log(`acentric-server ${version}`);
  process.exit(0);
}

let settings;
try {
  settings = readSettings(process.env);
} catch (error) {
  if (!(error instanceof InvalidSettings)) throw error;
  console.error(`The server was not started: ${error.message}`);
  process.exit(2);
}

// `acentric-server reset-link <email>`: a link that sets a person's password again, for one
// who can run this on the server itself. It is how an owner who is locked out gets back in.
if (process.argv[2] === 'reset-link') {
  const email = process.argv[3];
  if (email === undefined) {
    console.error('Say whose password: acentric-server reset-link <email>');
    process.exit(2);
  }
  try {
    const made = await resetLink(settings, email);
    console.log(made.link);
    console.log(`It works once, until ${new Date(made.expiresAt).toISOString()}.`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// `acentric-server reseal`: every sealed value sealed again with ACENTRIC_SECRET_KEY, with no
// server running on the data. After it, the keys in ACENTRIC_SECRET_KEYS_OLD seal nothing, and
// may go: how a key is changed.
if (process.argv[2] === 'reseal') {
  try {
    const sealed = resealData(settings);
    console.error(
      `sealed ${String(sealed)} values again with the key ${String(settings.secretKeys?.current)}`,
    );
    for (const line of keysSaid(settings)) console.error(line);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// `acentric-server compact`: the database vacuumed, with no server running on it: what it does
// not use is given back to the disk, and from then on what is removed is, as it goes.
if (process.argv[2] === 'compact') {
  try {
    const { before, after } = await compactData(settings);
    const mb = (bytes: number) => `${String(Math.round(bytes / 1_048_576))} MB`;
    console.error(`compacted the database from ${mb(before)} to ${mb(after)}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// `acentric-server backup [file]`, `check-backup [file]` and `restore [file] [--without-keys]`:
// a backup of the data, taken beside a server that runs on it; one checked; one put back, with
// no server running. Without a file, or with -, a backup goes to stdout and is read from stdin,
// so that it passes through `docker exec` and `kubectl exec`. A backup in a bucket is checked
// and put back from its URL, s3://bucket/folder/name.tar, reached as the server reaches it.
const command = process.argv[2];
if (command === 'backup' || command === 'check-backup' || command === 'restore') {
  const said = (line: string) => process.stderr.write(`${line}\n`);
  const file = process.argv.slice(3).find((arg) => !arg.startsWith('--'));
  const named = file !== undefined && file !== '-';
  const keys = Object.keys(settings.secretKeys?.keys ?? {});
  try {
    if (command === 'backup') {
      const manifest = await backupTo(settings, version, named ? file : undefined);
      said(
        `backed up ${String(manifest.blobs.count)} images and files and the database, ${String(Math.ceil((manifest.database.bytes + manifest.blobs.bytes) / 1_048_576))} MB, of schema ${String(manifest.schema)}${named ? ` to ${file}` : ''}`,
      );
      if (manifest.keys.length > 0) {
        said(
          `what is sealed in it opens with the key ${manifest.keys.join(', ')}, which is not in it`,
        );
      }
    } else {
      const inBucket = named && file.startsWith('s3://');
      if (named && !inBucket && !existsSync(file)) throw new Error(`There is no backup at ${file}`);
      const input: Readable = !named
        ? process.stdin
        : inBucket
          ? (await readObject(file, process.env)).input
          : createReadStream(file);
      // What goes wrong reading it is said where it is read, not thrown from nowhere.
      input.on('error', () => {});
      if (command === 'check-backup') {
        const { manifest, missing } = await checkBackup(input, keys, settings.data);
        said(
          `a whole ${manifest.kind} backup${manifest.kind === 'before-upgrade' ? `, before upgrading to ${manifest.engine}` : ` of ${manifest.engine}`}, taken ${new Date(manifest.createdAt).toISOString()}, with ${String(manifest.blobs.count)} images and files`,
        );
        if (missing.length > 0) {
          said(`it needs the key ${missing.join(', ')}, which this server was not given`);
          process.exit(3);
        }
      } else {
        const inside =
          settings.backups !== undefined && dirname(settings.backups.dir) === settings.data;
        const { manifest, before } = await restore({
          data: settings.data,
          input,
          keys,
          withoutKeys: process.argv.includes('--without-keys'),
          keep: inside && settings.backups !== undefined ? [basename(settings.backups.dir)] : [],
        });
        said(
          `restored the backup of ${manifest.engine}, taken ${new Date(manifest.createdAt).toISOString()}, to ${settings.data}`,
        );
        if (before !== undefined) said(`what was there before is in ${before}`);
      }
    }
    process.exit(0);
  } catch (error) {
    said(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// The server's log, as its settings say: text or JSON, from the level they give.
const logger = createLogger(settings.log);

let started;
try {
  started = await start(settings, { version, logger });
} catch (error) {
  // Said in a line: what was wrong is the message, not where in the code it was found.
  logger.error(
    `The server was not started: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
logger.info(`acentric-server ${version} listening on ${started.server.url}`);
if (started.metricsUrl !== undefined) logger.info(`metrics at ${started.metricsUrl}`);
if (started.recovered > 0) {
  logger.info(`picked up ${String(started.recovered)} actors with something owed`);
}
if (settings.secretKeys === undefined) {
  logger.warn('ACENTRIC_SECRET_KEY is not set: agents can be given no secrets');
}
if (started.setupLink !== undefined) {
  // Nobody can sign in yet. Whoever opens this makes themselves the owner.
  logger.info(`setup ${started.setupLink}`);
  logger.info('This link makes the owner of this server. It works once, for a week.');
}
if (started.firstKey !== undefined) {
  // Nothing could call the server otherwise. Not in the log, which is kept, and read, by more
  // than whoever runs the server: in a file of the data's, for that user alone.
  const file = join(settings.data, FIRST_KEY_FILE);
  writeFileSync(file, `${started.firstKey}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  logger.info(`key: the first key, which may do everything, is in ${file}`);
  logger.info('Copy it somewhere safe, and remove the file: it is not written again.');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    // /health says it is stopping first, and it goes on answering a moment, so that what is in
    // front sends what comes next elsewhere before it takes no more.
    logger.info('stopping');
    started.drain();
    setTimeout(() => {
      void started.close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('the server did not stop as it should', {}, error);
          process.exit(1);
        },
      );
    }, DRAIN_MS);
  });
}
