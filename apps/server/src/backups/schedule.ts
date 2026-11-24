// The server's own backups: one every so often, one before a new version changes its database,
// and one when someone asks for it, each in the backups' folder, with the oldest of each kind
// removed past how many are kept. What became of the last is kept, for the API to say, and in
// the audit log.
//
// A backup is written under a name of its own, and named for what it is once it is whole: a
// file of a backup's name is one that was finished. With a bucket, each is then copied there
// as well, and the bucket keeps as many of each kind as the folder does: a backup that is in
// the folder and could not be copied is one that failed.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import type { Audit } from '@acentric/core';
import type { PrincipalRef } from '@acentric/protocol';

import { DATABASE, makeBackup } from './archive.ts';
import type { Bucket } from './bucket.ts';
import type { BackupKind, Manifest } from './archive.ts';

/** A backup in the folder: `acentric-<time>-<kind>-<version>.tar`. */
const NAME =
  /^acentric-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)-(scheduled|before-upgrade|manual)-(.+)\.tar$/;

export type BackupFile = {
  readonly name: string;
  readonly kind: BackupKind;
  /** The version of the server that took it. */
  readonly version: string;
  readonly createdAt: number;
  readonly bytes: number;
};

/** The longest a timer waits: Node's hold 2^31 - 1 ms, some 24.8 days, and fire at once past it. */
const LONGEST_TIMER_MS = 2_000_000_000;
/** A backup, where it is: in the folder on the server, in the bucket, or both. */
export type PlacedBackup = BackupFile & { readonly onServer: boolean; readonly inBucket: boolean };

/** What became of the last backup. */
export type LastBackup =
  | { readonly ok: true; readonly at: number; readonly name: string }
  | { readonly ok: false; readonly at: number; readonly error: string };

const stamp = (at: number): string =>
  new Date(at)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');

const timeOf = (text: string): number =>
  Date.parse(text.replace(/T(\d\d)-(\d\d)-(\d\d)Z$/, 'T$1:$2:$3Z'));

/** The backup a file of `name` is, or undefined when that is not a backup's name. */
function fileOf(name: string, bytes: number): BackupFile | undefined {
  const match = NAME.exec(name);
  if (match === null) return undefined;
  return {
    name,
    kind: match[2] as BackupKind,
    version: match[3] ?? '',
    createdAt: timeOf(match[1] ?? ''),
    bytes,
  };
}

const newestFirst = <T extends BackupFile>(files: T[]): T[] =>
  files.toSorted((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));

/** The backups in `dir`, newest first. */
export async function listBackups(dir: string): Promise<BackupFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: BackupFile[] = [];
  for (const name of names) {
    const there = await stat(join(dir, name)).catch(() => undefined);
    const file = there === undefined ? undefined : fileOf(name, there.size);
    if (file !== undefined) files.push(file);
  }
  return newestFirst(files);
}

/** The backups in `bucket`, newest first. */
export async function listBucket(bucket: Bucket): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  for (const object of await bucket.list()) {
    const file = fileOf(object.name, object.bytes);
    if (file !== undefined) files.push(file);
  }
  return newestFirst(files);
}

/** What a backup of `data` needs on disk, and some to spare: its database and blobs. */
async function sizeOf(data: string): Promise<number> {
  let bytes = (await stat(join(data, DATABASE)).catch(() => undefined))?.size ?? 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else bytes += (await stat(path).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(join(data, 'blobs'));
  return Math.ceil(bytes * 1.1) + 1_048_576;
}

export class Backups {
  readonly #data: string;
  readonly #dir: string;
  readonly #everyMs: number;
  readonly #keep: number;
  readonly #version: string;
  readonly #withoutRemovals: <T>(work: () => Promise<T>) => Promise<T>;
  readonly #audit: Audit | undefined;
  readonly #bucket: Bucket | undefined;
  readonly #clock: () => number;
  readonly #log: (line: string) => void;
  /** The backup being taken: the next waits for it. */
  #running: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #next: number | null = null;
  #last: LastBackup | null = null;
  /** When the newest backup in the folder was taken, of any kind. */
  #newest: number | undefined;
  #failures = 0;
  #closed = false;

  constructor(options: {
    readonly data: string;
    readonly dir: string;
    readonly everyMs: number;
    readonly keep: number;
    readonly version: string;
    readonly withoutRemovals: <T>(work: () => Promise<T>) => Promise<T>;
    readonly audit?: Audit;
    /** The bucket each is copied to as well. */
    readonly bucket?: Bucket;
    readonly clock?: () => number;
    readonly log?: (line: string) => void;
  }) {
    this.#data = options.data;
    this.#dir = options.dir;
    this.#everyMs = options.everyMs;
    this.#keep = options.keep;
    this.#version = options.version;
    this.#withoutRemovals = options.withoutRemovals;
    this.#audit = options.audit;
    this.#bucket = options.bucket;
    this.#clock = options.clock ?? Date.now;
    this.#log = options.log ?? ((line) => console.log(line));
  }

  get dir(): string {
    return this.#dir;
  }
  get everyMs(): number {
    return this.#everyMs;
  }
  get keep(): number {
    return this.#keep;
  }
  /** When the next scheduled backup is taken. Null when none is, as when it is closed. */
  get next(): number | null {
    return this.#next;
  }
  get last(): LastBackup | null {
    return this.#last;
  }
  /** When the newest backup there is was taken, as the folder says. Undefined for none. */
  get newestAt(): number | undefined {
    return this.#newest;
  }
  /** How many backups failed since the server started. */
  get failures(): number {
    return this.#failures;
  }
  /** Where in a bucket each is copied to as well. Undefined when there is none. */
  get bucketUrl(): string | undefined {
    return this.#bucket?.url;
  }

  /**
   * The backups there are, in the folder and in the bucket, newest first; and what went wrong
   * listing the bucket, when something did.
   */
  async list(): Promise<{ readonly items: PlacedBackup[]; readonly bucketError: string | null }> {
    const here = await listBackups(this.#dir);
    let there: BackupFile[] = [];
    let bucketError: string | null = null;
    if (this.#bucket !== undefined) {
      try {
        there = await listBucket(this.#bucket);
      } catch (error) {
        bucketError = error instanceof Error ? error.message : String(error);
      }
    }
    const inBucket = new Set(there.map((file) => file.name));
    const onServer = new Set(here.map((file) => file.name));
    return {
      items: newestFirst([
        ...here.map((file) => ({ ...file, onServer: true, inBucket: inBucket.has(file.name) })),
        ...there
          .filter((file) => !onServer.has(file.name))
          .map((file) => ({ ...file, onServer: false, inBucket: true })),
      ]),
      bucketError,
    };
  }

  /** Whether the backups are on the disk of what they back up, and so lost with it. */
  async sameDisk(): Promise<boolean> {
    await mkdir(this.#dir, { recursive: true });
    return (await stat(this.#dir)).dev === (await stat(this.#data)).dev;
  }

  /**
   * Schedules backups: the first once one is due, as the newest scheduled one in the folder
   * says, or a minute from now when there is none or it is due already.
   */
  async start(): Promise<void> {
    const there = await listBackups(this.#dir);
    this.#newest = there[0]?.createdAt;
    const newest = there.find((file) => file.kind === 'scheduled');
    const now = this.#clock();
    const due = newest === undefined ? now : newest.createdAt + this.#everyMs;
    this.#schedule(Math.max(due, now + 60_000));
    // Said at the start, and not only at the first backup: a bucket it cannot reach.
    if (this.#bucket !== undefined) {
      const bucket = this.#bucket;
      void bucket.list().then(
        () => this.#log(`backups are copied to ${bucket.url} as well`),
        (error: unknown) =>
          this.#log(
            `backups are not copied to ${bucket.url}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    }
  }

  #schedule(at: number): void {
    if (this.#closed) return;
    this.#next = at;
    this.#timer = setTimeout(
      () => {
        // A time further off than a timer holds is waited for a part at a time.
        if (this.#clock() < at) {
          this.#schedule(at);
          return;
        }
        void this.take('scheduled').finally(() => {
          this.#schedule(this.#clock() + this.#everyMs);
        });
      },
      Math.min(Math.max(0, at - this.#clock()), LONGEST_TIMER_MS),
    );
    this.#timer.unref();
  }

  /**
   * Takes a backup now, of `kind`, by `by`: into the folder, with the oldest of its kind past
   * how many are kept removed. It waits for one being taken already.
   */
  take(kind: BackupKind, by: PrincipalRef = { type: 'system' }): Promise<BackupFile> {
    const done = this.#running.then(
      () => this.#take(kind, by),
      () => this.#take(kind, by),
    );
    this.#running = done.catch(() => {});
    return done;
  }

  async #take(kind: BackupKind, by: PrincipalRef): Promise<BackupFile> {
    const started = this.#clock();
    let written: BackupFile | undefined;
    try {
      const file = await this.#write(kind);
      written = file;
      await this.#prune(kind);
      if (this.#bucket !== undefined) {
        try {
          await this.#bucket.put(join(this.#dir, file.name), file.name);
        } catch (error) {
          throw new Error(
            `${file.name} is in ${this.#dir}, and was not copied to the bucket: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      this.#last = { ok: true, at: this.#clock(), name: file.name };
      this.#newest = file.createdAt;
      await this.#audit?.record({
        by,
        action: 'backup.made',
        detail: {
          name: file.name,
          kind,
          bytes: file.bytes,
          ms: this.#clock() - started,
          ...(this.#bucket === undefined ? {} : { bucket: this.#bucket.url }),
        },
      });
      this.#log(
        `backed up to ${join(this.#dir, file.name)}${this.#bucket === undefined ? '' : ` and ${this.#bucket.url}`}`,
      );
      await this.#pruneBucket(kind);
      return file;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#last = { ok: false, at: this.#clock(), error: message };
      this.#failures += 1;
      await this.#audit?.record({
        by,
        action: 'backup.failed',
        detail: { kind, error: message, ...(written === undefined ? {} : { name: written.name }) },
      });
      this.#log(`the backup failed: ${message}`);
      throw error;
    }
  }

  async #write(kind: BackupKind): Promise<BackupFile> {
    await mkdir(this.#dir, { recursive: true });
    const needs = await sizeOf(this.#data);
    const free = await statfs(this.#dir);
    if (free.bavail * free.bsize < needs) {
      throw new Error(
        `${this.#dir} has ${String(Math.floor((free.bavail * free.bsize) / 1_048_576))} MB free, and a backup needs about ${String(Math.ceil(needs / 1_048_576))} MB`,
      );
    }
    const at = this.#clock();
    const name = `acentric-${stamp(at)}-${kind}-${this.#version}.tar`;
    const partial = join(this.#dir, `.${name}.partial`);
    const out = createWriteStream(partial);
    let manifest: Manifest;
    try {
      manifest = await makeBackup({
        data: this.#data,
        out,
        version: this.#version,
        kind,
        withoutRemovals: this.#withoutRemovals,
        clock: this.#clock,
      });
      out.end();
      await finished(out);
      await rename(partial, join(this.#dir, name));
    } catch (error) {
      out.destroy();
      await rm(partial, { force: true });
      throw error;
    }
    return {
      name,
      kind,
      version: this.#version,
      createdAt: manifest.createdAt,
      bytes: (await stat(join(this.#dir, name))).size,
    };
  }

  /** How many of `kind` are kept. */
  #keeps(kind: BackupKind): number {
    return kind === 'before-upgrade' ? Math.min(this.#keep, 2) : this.#keep;
  }

  /** Removes the oldest backups of `kind` in the folder past how many are kept. */
  async #prune(kind: BackupKind): Promise<void> {
    const own = (await listBackups(this.#dir)).filter((file) => file.kind === kind);
    for (const file of own.slice(this.#keeps(kind))) {
      await rm(join(this.#dir, file.name), { force: true });
    }
  }

  /**
   * Removes the oldest backups of `kind` in the bucket past how many are kept. What goes wrong
   * is said, and the backup that was copied is still one that was made.
   */
  async #pruneBucket(kind: BackupKind): Promise<void> {
    if (this.#bucket === undefined) return;
    try {
      const own = (await listBucket(this.#bucket)).filter((file) => file.kind === kind);
      for (const file of own.slice(this.#keeps(kind))) await this.#bucket.remove(file.name);
    } catch (error) {
      this.#log(
        `the oldest backups in ${this.#bucket.url} were not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Stops scheduling, and waits for a backup being taken. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#next = null;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#running;
    this.#bucket?.close();
  }
}
