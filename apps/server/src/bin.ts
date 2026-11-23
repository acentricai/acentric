#!/usr/bin/env node
// The server's program. It reads its settings from the environment (see `settings.ts`),
// starts, and says where it listens. Told to stop, it finishes what it is in the middle of.

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Readable } from 'node:stream';

import { checkBackup, restore } from './backups/archive.ts';
import { readObject } from './backups/bucket.ts';
import { backupTo } from './backups/command.ts';

import { InvalidSettings, readSettings } from './settings.ts';
import { resetLink, start } from './start.ts';

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

let started;
try {
  started = await start(settings, { version });
} catch (error) {
  // Said in a line: what was wrong is the message, not where in the code it was found.
  console.error(
    `The server was not started: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
console.log(`acentric-server ${version} listening on ${started.server.url}`);
if (started.recovered > 0) {
  console.log(`picked up ${String(started.recovered)} actors with something owed`);
}
if (settings.secretKeys === undefined) {
  console.log('ACENTRIC_SECRET_KEY is not set: agents can be given no secrets');
}
if (started.setupLink !== undefined) {
  // Nobody can sign in yet. Whoever opens this makes themselves the owner.
  console.log(`setup ${started.setupLink}`);
  console.log('This link makes the owner of this server. It works once, for a week.');
}
if (started.firstKey !== undefined) {
  // Nothing could call the server otherwise. It is shown here once, and kept nowhere.
  console.log(`key ${started.firstKey}`);
  console.log('This key may do everything, and is not shown again. Keep it somewhere safe.');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('stopping');
    void started.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
