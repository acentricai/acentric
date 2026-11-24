// Everything the database keeps sealed, in one list: what a backup says it needs which keys for,
// what a server says is still sealed with a key it was given as an old one, and what
// `acentric-server reseal` seals again with the current key, after which the old may go.

import type { DatabaseSync } from 'node:sqlite';

import { openWith, sealWith, sealedFor, sealedWith } from '@acentric/core';
import type { SecretKeys } from '@acentric/core';

type Row = { readonly a: string; readonly b: string | null; readonly value: string };

const SEALED: readonly {
  readonly what: string;
  readonly select: string;
  /** Sets the value of a row, where it is still what was read: (value, a, [b,] read). */
  readonly update: string;
  readonly bound: (row: Row) => string;
}[] = [
  {
    what: "an agent's secret",
    select: 'SELECT agent_id AS a, name AS b, sealed AS value FROM secrets',
    update: 'UPDATE secrets SET sealed = ? WHERE agent_id = ? AND name = ? AND sealed = ?',
    bound: (row) => sealedFor.secret(row.a, row.b ?? ''),
  },
  {
    what: "a model account's key",
    select: 'SELECT id AS a, NULL AS b, sealed AS value FROM accounts',
    update: 'UPDATE accounts SET sealed = ? WHERE id = ? AND sealed = ?',
    bound: (row) => sealedFor.account(row.a),
  },
  {
    what: "a sandbox provider's key",
    select:
      'SELECT id AS a, NULL AS b, credential AS value FROM sandbox_providers WHERE credential IS NOT NULL',
    update: 'UPDATE sandbox_providers SET credential = ? WHERE id = ? AND credential = ?',
    bound: (row) => sealedFor.provider(row.a),
  },
  {
    what: "an actor's variables",
    select:
      'SELECT id AS a, NULL AS b, machine_env AS value FROM actors WHERE machine_env IS NOT NULL',
    update: 'UPDATE actors SET machine_env = ? WHERE id = ? AND machine_env = ?',
    bound: (row) => sealedFor.actorEnv(row.a),
  },
  {
    what: "the backups' bucket's secret",
    select:
      'SELECT id AS a, NULL AS b, bucket_secret AS value FROM backup_settings WHERE bucket_secret IS NOT NULL',
    update: 'UPDATE backup_settings SET bucket_secret = ? WHERE id = ? AND bucket_secret = ?',
    bound: () => sealedFor.backupBucket(),
  },
];

/** Those of the tables there are: a database of an older version has fewer. */
function presentIn(db: DatabaseSync): typeof SEALED {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name),
  );
  return SEALED.filter(({ select }) => tables.has(/ FROM (\w+)/.exec(select)?.[1] ?? ''));
}

/** How many values are sealed with each key, by its ID. */
export function sealedKeys(db: DatabaseSync): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { select } of presentIn(db)) {
    for (const row of db.prepare(select).all() as Row[]) {
      const id = sealedWith(row.value);
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Seals every value another key sealed with the current one, in one transaction, and says how
 * many. One that does not open with the keys there are is not changed, and fails it all.
 */
export function reseal(db: DatabaseSync, keys: SecretKeys): number {
  let sealed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { what, select, update, bound } of presentIn(db)) {
      const set = db.prepare(update);
      for (const row of db.prepare(select).all() as Row[]) {
        if (sealedWith(row.value) === keys.current) continue;
        const value = openWith(keys, bound(row), row.value, `${what} (${row.a})`);
        const again = sealWith(keys, bound(row), value);
        const args = row.b === null ? [again, row.a, row.value] : [again, row.a, row.b, row.value];
        set.run(...args);
        sealed += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return sealed;
}
