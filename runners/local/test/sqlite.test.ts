import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteStore } from '../dist/index.js';
import { describeStore } from './store-suite.js';

describeStore('SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-sqlite-'));
  return {
    open: () => openSqliteStore(join(dir, 'store.db')),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
});
