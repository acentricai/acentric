// The stores the runner's tests run against, each opened at a path in a
// test's own folder.

import { openFileStore, openSqliteStore } from '../dist/index.js';
import type { Store } from '../dist/index.js';

export type StoreKind = {
  name: string;
  /** How acentric-runner's --store names it, at `path`. */
  spec(path: string): string;
  open(path: string): Promise<Store>;
};

export const SQLITE: StoreKind = {
  name: 'SQLite',
  spec: (path) => `sqlite:${path}.db`,
  open: (path) => openSqliteStore(`${path}.db`),
};

export const FILES: StoreKind = {
  name: 'filesystem',
  spec: (path) => `fs:${path}`,
  open: (path) => openFileStore(path),
};

export const STORES: StoreKind[] = [SQLITE, FILES];
