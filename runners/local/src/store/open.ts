// Opening a store from how a command line names it.

import { openFileStore } from './files.js';
import { openSqliteStore } from './sqlite.js';
import { StoreError } from './types.js';
import type { Store } from './types.js';

/** Opens `sqlite:PATH`, a SQLite file, or `fs:DIR`, a folder of plain files. */
export function openStore(spec: string): Promise<Store> {
  if (spec.startsWith('sqlite:')) return openSqliteStore(spec.slice('sqlite:'.length));
  if (spec.startsWith('fs:')) return openFileStore(spec.slice('fs:'.length));
  return Promise.reject(new StoreError('invalid', `a store is sqlite:PATH or fs:DIR, not ${spec}`));
}
