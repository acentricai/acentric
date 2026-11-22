import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileBlobStore } from '../src/index.ts';

const blob = (fill: number, length = 2000) => {
  const bytes = new Uint8Array(length).fill(fill);
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
};

describe('the blob store that is a folder', () => {
  let dir: string;
  let store: FileBlobStore;
  /** Every file under the folder, by its path from it. */
  const files = async () =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'acentric-blobs-'));
    store = new FileBlobStore(join(dir, 'blobs'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps bytes as a file named by their digest, and gives them back', async () => {
    const one = blob(1);
    const two = blob(2, 0);
    // The folder is made when it is first needed.
    expect(await store.list()).toEqual([]);
    expect(await store.get(one.digest)).toBeUndefined();

    await store.put(one.digest, one.bytes);
    await store.put(two.digest, two.bytes);
    expect(new Uint8Array((await store.get(one.digest)) ?? [])).toEqual(one.bytes);
    expect((await store.get(two.digest))?.byteLength).toBe(0);
    expect((await store.list()).toSorted()).toEqual([one.digest, two.digest].toSorted());
    // Spread over folders by the start of the name, and nothing left from the writing.
    expect((await files()).toSorted()).toEqual(
      [one, two]
        .map(({ digest }) => join('blobs', digest.slice(0, 2), digest.slice(2, 4), digest))
        .toSorted(),
    );
    expect(await readFile(join(dir, (await files())[0] ?? ''))).toBeDefined();
  });

  it('leaves what is there as it is when the same bytes are kept again', async () => {
    const one = blob(1);
    await store.put(one.digest, one.bytes);
    const [path] = await files();
    // What is under a name is never written over: the name is what the bytes are.
    await store.put(one.digest, new Uint8Array(3));
    expect(new Uint8Array((await store.get(one.digest)) ?? [])).toEqual(one.bytes);
    expect(await files()).toEqual([path]);
    // Kept by many at once, there is one file, and it is whole.
    const other = blob(9, 200_000);
    await Promise.all(Array.from({ length: 8 }, () => store.put(other.digest, other.bytes)));
    expect(new Uint8Array((await store.get(other.digest)) ?? [])).toEqual(other.bytes);
    expect(await files()).toHaveLength(2);
  });

  it('removes bytes, and does nothing for those that are not there', async () => {
    const one = blob(1);
    await store.put(one.digest, one.bytes);
    await store.remove(one.digest);
    await store.remove(one.digest);
    expect(await store.get(one.digest)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('takes no name that is not a digest: none is a path out of its folder', async () => {
    const outside = join(dir, 'outside');
    await writeFile(outside, 'not a blob');
    for (const name of [
      '../outside',
      '..',
      'a'.repeat(63),
      'A'.repeat(64),
      `${'a'.repeat(64)}/x`,
    ]) {
      await expect(store.get(name), name).rejects.toThrow(/is not the name of a blob/);
      await expect(store.put(name, new Uint8Array(1)), name).rejects.toThrow(/not the name/);
      await expect(store.remove(name), name).rejects.toThrow(/not the name/);
    }
    expect(await readFile(outside, 'utf8')).toBe('not a blob');
  });

  it('is rid, when it is listed, of what a process died in the middle of writing', async () => {
    const one = blob(1);
    await store.put(one.digest, one.bytes);
    const [path] = await files();
    const partial = join(dir, path ?? '', '..', `.${'b'.repeat(64)}.0a1b2c3d4e5f.partial`);
    await writeFile(partial, 'half of');
    await writeFile(join(dir, 'blobs', 'notes.txt'), 'something a person left here');
    expect(await store.list()).toEqual([one.digest]);
    expect((await files()).toSorted()).toEqual([join('blobs', 'notes.txt'), path].toSorted());
  });
});
