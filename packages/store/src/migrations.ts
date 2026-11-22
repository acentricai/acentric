// The tables, and how a database made by an older version is brought up to this one.
//
// A migration is never changed once it has been released: a change to the tables is a new
// migration, after the last. The database keeps how many it has had, in `user_version`.

import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  `
  -- An agent: what was deployed under a name.
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    -- The deployment a new actor is created on, and actors that are not pinned move to.
    active_id TEXT NOT NULL,
    active_version INTEGER NOT NULL,
    -- Its newest deployment.
    latest_id TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- A deployment of an agent. A row is never changed.
  CREATE TABLE deployments (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    -- JSON: the deployment, with what its code said of itself.
    deployment TEXT NOT NULL,
    -- The code: one ES module.
    code TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX deployments_version ON deployments (agent_id, version);

  -- An agent's secrets. A value is sealed with a key the database never has.
  CREATE TABLE secrets (
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sealed TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, name)
  ) STRICT, WITHOUT ROWID;

  -- An API key. The key itself is not here: only what tells a key that is sent is the one.
  CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    -- JSON: the key as the API shows it.
    key TEXT NOT NULL,
    -- The SHA-256 of its secret part, in hex.
    hash TEXT NOT NULL,
    -- The key that made it, which it is revoked with.
    parent TEXT
  ) STRICT;

  -- A person. Their password is not here: only what tells a password that is given is theirs.
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    -- What they sign in as.
    email TEXT NOT NULL UNIQUE,
    -- JSON: the person as the API shows them.
    user TEXT NOT NULL,
    password TEXT NOT NULL
  ) STRICT;

  -- A person signed in somewhere.
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    -- JSON: the session as the API shows it.
    session TEXT NOT NULL,
    -- The SHA-256 of its token's secret part, in hex.
    hash TEXT NOT NULL
  ) STRICT;

  CREATE INDEX sessions_user ON sessions (user_id, id);

  -- A link that is used once: a setup, an invite, or a reset of a password.
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    -- JSON: the link, without what it ends in.
    link TEXT NOT NULL
  ) STRICT;

  -- What was done, and by whom. A row is never changed.
  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    -- JSON: the event.
    event TEXT NOT NULL
  ) STRICT;

  CREATE INDEX audit_events_action ON audit_events (action, id);

  -- An actor, and where its turn stands.
  CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    deployment_version INTEGER NOT NULL,
    -- 1 for one that stays on its deployment.
    pinned INTEGER NOT NULL,
    -- JSON: the deployment it could not move to, and why. NULL for one that is where it is to be.
    behind TEXT,
    name TEXT,
    external_id TEXT,
    model TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    -- JSON, or NULL for an actor that has none.
    configuration TEXT,
    -- JSON: the configuration as it was given, which a move to another deployment checks.
    configuration_given TEXT,
    -- What names the instructions and tools of the last call its model answered.
    sent TEXT,
    -- The model's reasoning from before this place in the conversation is not sent to it.
    reasoning_from INTEGER NOT NULL,
    -- The reasoning level its calls are sent with, where that is not the level it is at.
    reasoning_sent TEXT,
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
  -- An agent's actors, as a list of them is read.
  CREATE INDEX actors_agent ON actors (agent_id, id);
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
  -- What waits: what a turn looks for.
  CREATE INDEX inputs_pending ON inputs (actor_id) WHERE delivered_at IS NULL;
  -- An actor's inputs, as a list of them is read.
  CREATE INDEX inputs_actor ON inputs (actor_id, id);
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
