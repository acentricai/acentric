// A blob store that is a folder: each blob a file, named by its digest.
//
// Files are spread over folders by the start of their names, so that no folder has too many.
// A blob is written beside where it goes and moved into place, so a file that is there is
// whole: one a process died in the middle of writing is never read as a blob.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { BlobStore } from '@acentric/core';

const DIGEST = /^[0-9a-f]{64}$/;

/** What `error` is, when it is that a file or folder is not there. */
const missing = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'ENOENT';

export class FileBlobStore implements BlobStore {
  readonly #root: string;

  /** `root` is the folder the blobs are in. It is made when the first blob is kept. */
  constructor(root: string) {
    this.#root = root;
  }

  /** Where a blob is. A name that is no digest is no path: it names nothing outside the folder. */
  #path(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`${digest} is not the name of a blob`);
    return join(this.#root, digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(digest);
    try {
      const there = await open(path, 'r');
      await there.close();
      // The same name is the same bytes.
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const folder = join(path, '..');
    await mkdir(folder, { recursive: true });
    const partial = join(folder, `.${digest}.${randomBytes(6).toString('hex')}.partial`);
    try {
      const file = await open(partial, 'wx');
      try {
        await file.writeFile(bytes);
        // On the disk before it is said to be kept: what the database says is there is there.
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async get(digest: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.#path(digest));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async remove(digest: string): Promise<void> {
    await rm(this.#path(digest), { force: true });
  }

  /**
   * Every blob there is. What a process died in the middle of writing is removed on the way:
   * this is asked when an engine starts, and nothing is being written then.
   */
  async list(): Promise<string[]> {
    const digests: string[] = [];
    const entries = await readdir(this.#root, { recursive: true, withFileTypes: true }).catch(
      (error: unknown) => {
        if (missing(error)) return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (DIGEST.test(entry.name)) digests.push(entry.name);
      else if (entry.name.endsWith('.partial')) {
        await rm(join(entry.parentPath, entry.name), { force: true });
      }
    }
    return digests;
  }
}
