// A backup of a server's data, and putting one back.
//
// What a server keeps is a SQLite database and, beside it, the images and files of
// conversations, each a file named by its SHA-256 (see FileBlobStore). A backup is a tar
// archive of:
//
//   manifest.json         what the backup is: of which version, of which schema, when, and
//                         which keys what is sealed in it needs
//   engine.sqlite         the database, as it was at one moment, taken by SQLite's own online
//                         backup while the server goes on writing
//   blobs/ab/cd/<digest>  every image and file that database refers to
//
// Keeping a blob writes its file first, then the database's row; removing one removes the row
// first, then the file. So every blob the database refers to has its file, as long as none is
// removed while they are copied: the server holds removals back while it backs itself up, and a
// backup taken beside it checks for each file before it starts, and starts again if one went.
//
// The key that seals secrets and model accounts' keys is never in a backup. The manifest says
// which keys sealed what is in it, by their IDs, so that a restore knows before it puts anything
// back whether this server can open them.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { SCHEMA_VERSION } from '@acentric/store';

import { lockData, LOCK_FILE } from './lock.ts';
import { END, header, padding, readArchive, write } from './tar.ts';

/** The version of the format: what a restore checks it can read. */
const FORMAT = 1;

export const DATABASE = 'engine.sqlite';
const BLOBS = 'blobs';
/** How many times a backup taken beside a server starts again when a blob went while it was. */
const ATTEMPTS = 5;

/** Why a backup was taken. */
export type BackupKind = 'scheduled' | 'before-upgrade' | 'manual';

export type Manifest = {
  readonly format: number;
  /** The version of the server whose data it is. */
  readonly engine: string;
  /** How many migrations its database has had. */
  readonly schema: number;
  readonly kind: BackupKind;
  readonly createdAt: number;
  readonly database: { readonly bytes: number; readonly sha256: string };
  readonly blobs: { readonly count: number; readonly bytes: number };
  /** The IDs of the keys that sealed what is in it: the keys a server needs to open it. */
  readonly keys: readonly string[];
};

/** Where a blob's file is, from the folder of data, as FileBlobStore has it. */
const blobPath = (digest: string): string =>
  `${BLOBS}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;

/** A blob was removed while it was being backed up: the backup is taken again. */
class BlobWent extends Error {
  constructor(digest: string) {
    super(
      `The image or file ${digest}, which the database refers to, is not in the folder of blobs`,
    );
  }
}

const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/** The IDs of the keys that sealed what a database has sealed in it. */
function keysOf(db: DatabaseSync): string[] {
  const ids = new Set<string>();
  const sealed = [
    'SELECT sealed AS value FROM secrets',
    'SELECT sealed AS value FROM accounts',
    'SELECT credential AS value FROM sandbox_providers WHERE credential IS NOT NULL',
  ];
  for (const query of sealed) {
    for (const row of db.prepare(query).all() as { value: string }[]) {
      const id = row.value.split('.')[1];
      if (id !== undefined && id !== '') ids.add(id);
    }
  }
  return [...ids].toSorted();
}

/**
 * Takes a backup of the data in `data` and writes it to `out`, which it does not end. `version`
 * is the server's. `withoutRemovals` is the server's own, when it backs itself up: what is in
 * it is done with no blob removed meanwhile. Without it, a blob removed while it is copied
 * takes the backup again from the start, as long as nothing has been written to `out` yet.
 */
export async function makeBackup(options: {
  readonly data: string;
  readonly out: Writable;
  readonly version: string;
  readonly kind: BackupKind;
  readonly withoutRemovals?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly clock?: () => number;
}): Promise<Manifest> {
  const { data, out } = options;
  const clock = options.clock ?? Date.now;
  // Opening a database that is not there would make one.
  if (!existsSync(join(data, DATABASE))) {
    throw new Error(
      `There is no database in ${data} to back up: is it the server's ACENTRIC_DATA?`,
    );
  }
  const held = options.withoutRemovals ?? (<T>(work: () => Promise<T>) => work());
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await held(() => once());
    } catch (error) {
      if (!(error instanceof BlobWent) || attempt === ATTEMPTS) throw error;
    }
  }

  async function once(): Promise<Manifest> {
    const snapshot = join(data, `.backup-${randomBytes(6).toString('hex')}.sqlite`);
    try {
      // The database as it is now, whatever the server writes while it is copied.
      const source = new DatabaseSync(join(data, DATABASE));
      try {
        source.exec('PRAGMA query_only = ON');
        await backup(source, snapshot);
      } finally {
        source.close();
      }
      const db = new DatabaseSync(snapshot, { readOnly: true });
      let schema: number;
      let blobs: { digest: string; size: number }[];
      let keys: string[];
      try {
        schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        blobs = db.prepare('SELECT digest, size FROM blobs ORDER BY digest').all() as {
          digest: string;
          size: number;
        }[];
        keys = keysOf(db);
      } finally {
        db.close();
      }
      // Each blob it refers to is there, before anything is written.
      for (const blob of blobs) {
        const there = await stat(join(data, blobPath(blob.digest))).catch(() => undefined);
        if (there?.size !== blob.size) throw new BlobWent(blob.digest);
      }
      const database = (await stat(snapshot)).size;
      const manifest: Manifest = {
        format: FORMAT,
        engine: options.version,
        schema,
        kind: options.kind,
        createdAt: clock(),
        database: { bytes: database, sha256: await sha256Of(snapshot) },
        blobs: { count: blobs.length, bytes: blobs.reduce((sum, blob) => sum + blob.size, 0) },
        keys,
      };
      const now = manifest.createdAt;
      const text = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      await write(out, header('manifest.json', text.length, now));
      await write(out, text);
      await write(out, padding(text.length));
      await copy(out, snapshot, DATABASE, database, now);
      for (const blob of blobs) {
        await copy(out, join(data, blobPath(blob.digest)), blobPath(blob.digest), blob.size, now);
      }
      await write(out, END);
      return manifest;
    } finally {
      await rm(snapshot, { force: true });
    }
  }
}

/** Writes a file into the archive: its header, its bytes, and its padding. */
async function copy(
  out: Writable,
  path: string,
  name: string,
  size: number,
  mtime: number,
): Promise<void> {
  await write(out, header(name, size, mtime));
  let written = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      written += (chunk as Buffer).length;
      await write(out, chunk as Buffer);
    }
  } catch (error) {
    // Too late to start again: what was written of the archive is written.
    throw new Error(
      `${name} went while it was being backed up, and the backup is not whole: take it again`,
      { cause: error },
    );
  }
  if (written !== size) throw new Error(`${name} changed while it was being backed up`);
  await write(out, padding(size));
}

/** What `unpack` found in a backup, once it was checked. */
export type Unpacked = { readonly manifest: Manifest; readonly folder: string };

/**
 * Reads a backup into `folder`, as a folder of data: its database and its blobs. Each file is
 * checked as it comes: the database against the manifest, and each blob against its name. Then
 * the database is checked through, for being one this version runs and for having every blob
 * it refers to.
 */
export async function unpack(input: Readable, folder: string): Promise<Unpacked> {
  await mkdir(folder, { recursive: true });
  let manifest: Manifest | undefined;
  let database = false;
  const blobs = new Set<string>();
  await readArchive(input, async (entry, chunks) => {
    if (manifest === undefined) {
      if (entry.name !== 'manifest.json') throw new Error('This is no backup of Acentric’s');
      const parts: Buffer[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      manifest = readManifest(Buffer.concat(parts).toString('utf8'));
      return;
    }
    const digest = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(entry.name)?.[1];
    if (entry.name === DATABASE) {
      const sha256 = await save(chunks, join(folder, DATABASE));
      if (entry.size !== manifest.database.bytes || sha256 !== manifest.database.sha256) {
        throw new Error('The backup’s database is not the one it was taken with: it is damaged');
      }
      database = true;
    } else if (digest !== undefined && entry.name === blobPath(digest)) {
      await mkdir(join(folder, BLOBS, digest.slice(0, 2), digest.slice(2, 4)), {
        recursive: true,
      });
      if ((await save(chunks, join(folder, blobPath(digest)))) !== digest) {
        throw new Error(`The image or file ${digest} of the backup is damaged`);
      }
      blobs.add(digest);
    } else {
      throw new Error(`The backup has ${entry.name} in it, which no backup has`);
    }
  });
  if (manifest === undefined) throw new Error('This is no backup of Acentric’s: it is empty');
  if (!database) throw new Error('The backup has no database in it');
  const found: Manifest = manifest;

  const db = new DatabaseSync(join(folder, DATABASE), { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('The backup’s database does not check through: it is damaged');
    }
    const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (schema !== found.schema) throw new Error('The backup’s database is not what it says');
    const wanted = db.prepare('SELECT digest FROM blobs').all() as { digest: string }[];
    const missing = wanted.filter((row) => !blobs.has(row.digest));
    if (missing.length > 0) {
      throw new Error(`The backup does not have ${String(missing.length)} of its images and files`);
    }
  } finally {
    db.close();
  }
  return { manifest: found, folder };
}

function readManifest(text: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    throw new Error('This is no backup of Acentric’s: its manifest is not JSON');
  }
  if (manifest.format !== FORMAT) {
    throw new Error(
      `The backup is of format ${String(manifest.format)}, and this version reads ${String(FORMAT)}`,
    );
  }
  if (manifest.schema > SCHEMA_VERSION) {
    throw new Error(
      `The backup was taken by a newer version (${manifest.engine}), whose database this one cannot run`,
    );
  }
  return manifest;
}

/** Writes what comes to a file, and gives its SHA-256. */
async function save(chunks: AsyncIterable<Buffer>, path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    (async function* () {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    })(),
    createWriteStream(path),
  );
  return hash.digest('hex');
}

/**
 * Reads a backup through and checks it, as `restore` would, without putting it anywhere: into
 * a folder of `temp`'s, removed after. It gives the manifest, and the keys it needs that are not
 * among `keys`.
 */
export async function checkBackup(
  input: Readable,
  keys: readonly string[],
  temp: string,
): Promise<{ readonly manifest: Manifest; readonly missing: readonly string[] }> {
  const folder = join(temp, `.check-${randomBytes(6).toString('hex')}`);
  try {
    const { manifest } = await unpack(input, folder);
    return { manifest, missing: missingKeys(manifest, keys) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The keys a backup needs that a server was not given. */
export const missingKeys = (manifest: Manifest, given: readonly string[]): string[] =>
  manifest.keys.filter((id) => !given.includes(id));

/** What `restore` did. */
export type Restored = {
  readonly manifest: Manifest;
  /** Where what was in the folder of data before was put. Undefined when it had nothing. */
  readonly before: string | undefined;
};

/**
 * Puts a backup back in `data`. No server may be running on it: the lock says so. The backup is
 * read and checked whole before anything of `data` is touched. What was there is moved, not
 * removed, into `before-restore-<time>` beside it. A backup that needs a key this server was not
 * given is refused, unless `withoutKeys`: then all else is put back, and what that key sealed
 * does not open.
 */
export async function restore(options: {
  readonly data: string;
  readonly input: Readable;
  /** The IDs of the keys this server was given. */
  readonly keys: readonly string[];
  readonly withoutKeys?: boolean;
  /** Names of folders in `data` that are left where they are: the backups' own. */
  readonly keep?: readonly string[];
  readonly clock?: () => number;
}): Promise<Restored> {
  const { data } = options;
  await mkdir(data, { recursive: true });
  const lock = lockData(data);
  const time = new Date((options.clock ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const staging = join(data, `.restore-${time}`);
  try {
    const { manifest } = await unpack(options.input, staging);
    const missing = missingKeys(manifest, options.keys);
    if (missing.length > 0 && options.withoutKeys !== true) {
      throw new Error(
        `The backup has secrets or model accounts' keys sealed with the key ${missing.join(', ')}, which this server was not given. Give it that key as ACENTRIC_SECRET_KEY, or in ACENTRIC_SECRET_KEYS_OLD, or restore with --without-keys to put back all else.`,
      );
    }
    // What was there goes aside: moved, on the same disk, and so at once.
    const stays = new Set([
      LOCK_FILE,
      `${LOCK_FILE}-journal`,
      `.restore-${time}`,
      ...(options.keep ?? []),
    ]);
    const there = (await readdir(data)).filter(
      (name) => !stays.has(name) && !name.startsWith('before-restore-'),
    );
    let before: string | undefined;
    if (there.length > 0) {
      before = join(data, `before-restore-${time}`);
      await mkdir(before);
      for (const name of there) await rename(join(data, name), join(before, name));
    }
    await rename(join(staging, DATABASE), join(data, DATABASE));
    await rename(join(staging, BLOBS), join(data, BLOBS)).catch(async (error: unknown) => {
      // A backup with no blobs has no folder of them.
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
    return { manifest, before };
  } finally {
    await rm(staging, { recursive: true, force: true });
    lock.release();
  }
}
