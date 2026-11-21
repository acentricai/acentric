// The tables, and how a database made by an older version is brought up to this one.
//
// A migration is never changed once it has been released: a change to the tables is a new
// migration, after the last. The database keeps how many it has had, in `user_version`.

import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  `
  -- An actor, and where its turn stands.
  CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    deployment_version INTEGER NOT NULL,
    name TEXT,
    external_id TEXT,
    model TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    -- JSON, or NULL for an actor that has none.
    configuration TEXT,
    status TEXT NOT NULL,
    -- JSON, or NULL until it has had a turn.
    last_turn TEXT,
    -- JSON: what is owed next.
    turn TEXT NOT NULL,
    -- 1 while a turn is under way: what a process looks for when it starts.
    owed INTEGER NOT NULL,
    -- Counts the commits. A commit names the one it read.
    epoch INTEGER NOT NULL,
    next_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  ) STRICT;

  -- An external ID, and a name, are one actor's among its agent's.
  CREATE UNIQUE INDEX actors_external_id ON actors (agent_id, external_id)
    WHERE external_id IS NOT NULL;
  CREATE UNIQUE INDEX actors_name ON actors (agent_id, name) WHERE name IS NOT NULL;
  CREATE INDEX actors_owed ON actors (id) WHERE owed = 1;

  -- A conversation: one row a message, in order.
  CREATE TABLE messages (
    actor_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    -- JSON: the conversation entry.
    entry TEXT NOT NULL,
    PRIMARY KEY (actor_id, seq)
  ) STRICT, WITHOUT ROWID;

  -- A mailbox. A row is never removed: one a turn took has the time it was taken.
  CREATE TABLE inputs (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    type TEXT NOT NULL,
    external_id TEXT,
    -- JSON: the message it is in the conversation, or will be.
    message TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    delivered_at INTEGER
  ) STRICT;

  -- An external ID is one input's among its actor's: sending it again stores nothing.
  CREATE UNIQUE INDEX inputs_external_id ON inputs (actor_id, external_id)
    WHERE external_id IS NOT NULL;
  -- What waits: the only inputs anything looks for.
  CREATE INDEX inputs_pending ON inputs (actor_id) WHERE delivered_at IS NULL;
  `,
];

/** The version a database is at when it has had every migration. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the database up to this version. It refuses one made by a newer version. */
export function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version > MIGRATIONS.length) {
    throw new Error(
      `The database is at version ${String(version)}, and this engine knows ${String(MIGRATIONS.length)}: it was made by a newer one`,
    );
  }
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[index] as string);
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
