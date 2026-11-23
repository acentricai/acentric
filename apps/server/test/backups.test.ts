// Backups of a server's data, and putting one back: on a real database and folder of blobs.

import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { Secrets } from '@acentric/core';
import type { Actor, AgentId } from '@acentric/protocol';
import { makeId } from '@acentric/protocol';
import { FileBlobStore, SCHEMA_VERSION, SqliteStore } from '@acentric/store';

import { checkBackup, makeBackup, restore, unpack } from '../src/backups/archive.ts';
import type { Manifest } from '../src/backups/archive.ts';
import { DataInUse, lockData } from '../src/backups/lock.ts';
import { END, header, padding } from '../src/backups/tar.ts';

const folders: string[] = [];
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'acentric-backups-'));
  folders.push(made);
  return made;
};
afterAll(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

const NOW = 1_795_305_600_000;
const KEYS = { current: 'k1', keys: { k1: new Uint8Array(32).fill(7) } };
const agent = makeId('agent', { now: NOW, random: randomBytes(10) }) as AgentId;

const actorOf = (more: Partial<Actor> = {}): Actor => ({
  id: makeId('actor', { now: NOW, random: randomBytes(10) }),
  name: null,
  externalId: null,
  agent,
  deployment: { id: makeId('deployment', { now: NOW, random: randomBytes(10) }), version: 1 },
  pinned: false,
  behind: null,
  modelId: 'fake-1',
  reasoning: 'medium',
  configuration: null,
  machine: null,
  parent: null,
  status: 'idle',
  lastTurn: null,
  pendingInputs: 0,
  createdAt: NOW,
  archivedAt: null,
  ...more,
});

/** A folder of data as a server leaves it: a database, an actor with two images, a secret. */
async function dataWith(): Promise<{ data: string; actor: Actor; images: Buffer[] }> {
  const data = folder();
  const store = await SqliteStore.open(join(data, 'engine.sqlite'));
  const blobs = new FileBlobStore(join(data, 'blobs'));
  const actor = actorOf({ name: 'kept' });
  await store.createActor(actor);
  const images = [randomBytes(3000), randomBytes(70_000)];
  for (const bytes of images) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    await blobs.put(digest, bytes);
    await store.addBlob(actor.id, {
      digest,
      size: bytes.length,
      mediaType: 'image/png',
      createdAt: NOW,
    });
  }
  await new Secrets({ store, keys: KEYS }).set(agent, 'API_TOKEN', 'tok-123');
  await store.close();
  return { data, actor, images };
}

/** A backup of `data`, as a file. */
async function backupOf(
  data: string,
  file = join(folder(), 'backup.tar'),
): Promise<{ file: string; manifest: Manifest }> {
  const out = createWriteStream(file);
  const manifest = await makeBackup({
    data,
    out,
    version: '0.15.0',
    kind: 'manual',
    clock: () => NOW,
  });
  out.end();
  await finished(out);
  return { file, manifest };
}

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('a backup', () => {
  it('has the database, every image and file it refers to, and what it needs to be opened', async () => {
    const { data, actor, images } = await dataWith();
    const { file, manifest } = await backupOf(data);
    expect(manifest).toMatchObject({
      format: 1,
      engine: '0.15.0',
      schema: SCHEMA_VERSION,
      kind: 'manual',
      createdAt: NOW,
      blobs: { count: 2, bytes: 73_000 },
      keys: ['k1'],
    });
    // It is put back whole, somewhere else, and the database there has what was kept.
    const into = join(folder(), 'unpacked');
    const { manifest: read } = await unpack(createReadStream(file), into);
    expect(read).toEqual(manifest);
    const store = await SqliteStore.open(join(into, 'engine.sqlite'));
    expect((await store.loadActor(actor.id))?.actor.name).toBe('kept');
    const opened = await new Secrets({ store, keys: KEYS }).get(agent, 'API_TOKEN');
    expect(opened).toBe('tok-123');
    await store.close();
    const blobs = new FileBlobStore(join(into, 'blobs'));
    for (const bytes of images) {
      expect(Buffer.from((await blobs.get(digestOf(bytes))) ?? [])).toEqual(bytes);
    }
  });

  it('is of the database at one moment, while it is written to as the backup is taken', async () => {
    const { data } = await dataWith();
    const store = await SqliteStore.open(join(data, 'engine.sqlite'));
    const going = { writing: true };
    let made = 0;
    const writer = (async () => {
      while (going.writing) {
        await store.createActor(actorOf());
        made += 1;
      }
    })();
    const { file } = await backupOf(data);
    going.writing = false;
    await writer;
    await store.close();
    const into = join(folder(), 'unpacked');
    await unpack(createReadStream(file), into);
    // It opens, checks through, and has some of what was written, and none of it half.
    const copy = await SqliteStore.open(join(into, 'engine.sqlite'));
    const { items } = await copy.listActors({ limit: 1000 });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(made + 1);
    await copy.close();
    expect(made).toBeGreaterThan(0);
  });

  it('is refused, with what is wrong, when an image it refers to is not there', async () => {
    const { data, images } = await dataWith();
    const digest = digestOf(images[0] ?? Buffer.alloc(0));
    await rm(join(data, 'blobs', digest.slice(0, 2), digest.slice(2, 4), digest));
    await expect(backupOf(data)).rejects.toThrow(`The image or file ${digest}`);
  });

  it('is taken while the server holds removals back, when it is the server’s own', async () => {
    const { data } = await dataWith();
    const held: string[] = [];
    const out = new PassThrough();
    out.resume();
    await makeBackup({
      data,
      out,
      version: '0.15.0',
      kind: 'scheduled',
      withoutRemovals: async (work) => {
        held.push('held');
        const done = await work();
        held.push('let go');
        return done;
      },
    });
    expect(held).toEqual(['held', 'let go']);
  });
});

describe('checking a backup', () => {
  it('says which keys it needs that the server was not given', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    expect((await checkBackup(createReadStream(file), ['k1'], folder())).missing).toEqual([]);
    expect((await checkBackup(createReadStream(file), ['other'], folder())).missing).toEqual([
      'k1',
    ]);
  });

  it('finds an archive cut off, an image changed, and what is no backup', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    const whole = readFileSync(file);
    const check = (bytes: Buffer) => checkBackup(Readable.from([bytes]), ['k1'], folder());

    await expect(check(whole.subarray(0, whole.length - 3000))).rejects.toThrow('cut off');
    // A byte of the last image's bytes, which are just before the end.
    const changed = Buffer.from(whole);
    const at = whole.length - END.length - padding(70_000).length - 10;
    changed[at] = (changed[at] ?? 0) ^ 0xff;
    await expect(check(changed)).rejects.toThrow('is damaged');
    await expect(check(Buffer.from('not an archive at all'.padEnd(2048, ' ')))).rejects.toThrow(
      'a header does not add up',
    );
  });

  it('refuses a backup of a newer version', async () => {
    const newer = JSON.stringify({ format: 1, engine: '9.0.0', schema: SCHEMA_VERSION + 1 });
    const archive = Buffer.concat([
      header('manifest.json', newer.length, NOW),
      Buffer.from(newer),
      padding(newer.length),
      END,
    ]);
    await expect(checkBackup(Readable.from([archive]), [], folder())).rejects.toThrow(
      'taken by a newer version (9.0.0)',
    );
  });
});

describe('restoring a backup', () => {
  it('puts it back, with what was there moved aside, and leaves the backups’ folder', async () => {
    const { data, actor } = await dataWith();
    const { file } = await backupOf(data);
    // What happens after the backup, which the restore takes back.
    const store = await SqliteStore.open(join(data, 'engine.sqlite'));
    const later = actorOf({ name: 'later' });
    await store.createActor(later);
    await store.close();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(data, 'backups')));
    writeFileSync(join(data, 'backups', 'one.tar'), 'kept');

    const { before } = await restore({
      data,
      input: createReadStream(file),
      keys: ['k1'],
      keep: ['backups'],
      clock: () => NOW,
    });
    expect(before).toBeDefined();
    const restored = await SqliteStore.open(join(data, 'engine.sqlite'));
    expect((await restored.loadActor(actor.id))?.actor.name).toBe('kept');
    expect(await restored.loadActor(later.id)).toBeUndefined();
    await restored.close();
    // What was there is moved, not removed: the later actor is in it.
    const aside = await SqliteStore.open(join(before ?? '', 'engine.sqlite'));
    expect((await aside.loadActor(later.id))?.actor.name).toBe('later');
    await aside.close();
    expect(readFileSync(join(data, 'backups', 'one.tar'), 'utf8')).toBe('kept');
    expect((await readdir(data)).filter((name) => name.startsWith('.restore-'))).toEqual([]);
  });

  it('puts it in an empty folder, with nothing to move aside', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    const fresh = join(folder(), 'fresh');
    const { before } = await restore({ data: fresh, input: createReadStream(file), keys: ['k1'] });
    expect(before).toBeUndefined();
    expect((await readdir(fresh)).toSorted()).toEqual(['blobs', 'engine.lock', 'engine.sqlite']);
  });

  it('refuses one whose secrets the server cannot open, unless told to put back all else', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    const fresh = join(folder(), 'fresh');
    await expect(restore({ data: fresh, input: createReadStream(file), keys: [] })).rejects.toThrow(
      'sealed with the key k1, which this server was not given',
    );
    // Refused before anything was put there.
    expect(await readdir(fresh)).toEqual(['engine.lock']);
    await restore({ data: fresh, input: createReadStream(file), keys: [], withoutKeys: true });
    expect(await readdir(fresh)).toContain('engine.sqlite');
  });

  it('is refused while a server is running on the folder, and touches nothing', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    const lock = lockData(data);
    try {
      await expect(restore({ data, input: createReadStream(file), keys: ['k1'] })).rejects.toThrow(
        DataInUse,
      );
      expect((await readdir(data)).filter((name) => name.startsWith('before-restore-'))).toEqual(
        [],
      );
    } finally {
      lock.release();
    }
  });

  it('leaves the folder as it was when the backup is damaged', async () => {
    const { data } = await dataWith();
    const { file } = await backupOf(data);
    const whole = readFileSync(file);
    await expect(
      restore({
        data,
        input: Readable.from([whole.subarray(0, whole.length - 5000)]),
        keys: ['k1'],
      }),
    ).rejects.toThrow('cut off');
    // Nothing was moved aside, and what was read is gone.
    const left = await readdir(data);
    expect(left).toContain('engine.sqlite');
    expect(left.filter((name) => /^(before-restore|\.restore)-/.test(name))).toEqual([]);
  });
});

describe('the lock on a folder of data', () => {
  it('is one process’s or another’s, and is free once let go', () => {
    const data = folder();
    const first = lockData(data);
    expect(() => lockData(data)).toThrow(DataInUse);
    first.release();
    lockData(data).release();
  });
});
