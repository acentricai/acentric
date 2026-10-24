import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { openSqliteStore } from '../dist/index.js';
import { describeStore } from './store-suite.js';

describeStore('SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acentric-sqlite-'));
  return {
    open: () => openSqliteStore(join(dir, 'store.db')),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
});

describe('the SQLite store', () => {
  it('moves a store with schema 2 to 3, whose sessions keep no journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acentric-sqlite-'));
    try {
      const path = join(dir, 'store.db');
      const store = await openSqliteStore(path);
      await store.create(
        {
          id: 'old',
          agent: { name: 'echo', version: '1' },
          config: {},
          snapshot: {},
          nextSeq: 1,
          fault: null,
          createHash: 'c',
          createdAt: 1,
        },
        { append: [], started: [], journal: [] },
      );
      await store.close();
      // As a store written before journals: schema 2, with no journal table.
      const db = new DatabaseSync(path);
      db.exec("DROP TABLE journal; UPDATE meta SET value = '2' WHERE key = 'schema'");
      db.close();

      const again = await openSqliteStore(path);
      expect(await again.load('old')).toMatchObject({ id: 'old', nextEntry: null });
      expect(await again.readJournal('old')).toEqual([]);
      await again.close();
      const upgraded = new DatabaseSync(path);
      expect(upgraded.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({
        value: '3',
      });
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
