// The packages of the workspace, as found on disk: every folder of `packages` and `apps` that
// has a package.json. A folder without one, such as the Rust daemon's, is not a package here.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

/** The repository's root: the folder above this one. */
export const ROOT = resolve(import.meta.dirname, '..');

const GROUPS = ['packages', 'apps'];

/** The folders of the workspace's packages, from the root, such as `packages/core`. */
export function packageDirs(root: string = ROOT): string[] {
  const dirs: string[] = [];
  for (const group of GROUPS) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = posix.join(group, entry.name);
      if (existsSync(join(root, dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.toSorted();
}

/** A JSON file of the repository, by its path from the root. */
export function readJson(path: string, root: string = ROOT): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}
