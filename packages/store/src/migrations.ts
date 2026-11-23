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
    -- The model account its calls are made with. NULL: its provider's default.
    account_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- A model account: what the calls of a provider's models are made with.
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    -- JSON: the account as the API shows it, but for the agents given it.
    account TEXT NOT NULL,
    -- Its credential, sealed with a key the database never has.
    sealed TEXT NOT NULL
  ) STRICT;

  -- One row for each call of a model, answered or failed. What it names is kept as it was: an
  -- actor, an agent or an account removed later is still in what was spent.
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    -- The actor at the top of its tree of subagents: itself, for one created from outside.
    root_actor_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    account_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    -- The kind of failure, for a call that failed.
    failure TEXT,
    total_input INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    web_searches INTEGER NOT NULL DEFAULT 0,
    -- In US dollars. NULL when it cannot be known.
    cost REAL,
    -- 'reported' by the provider, or 'estimated' from the model's prices.
    cost_source TEXT,
    duration_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX usage_at ON usage (at);
  CREATE INDEX usage_actor ON usage (actor_id, at);
  CREATE INDEX usage_root ON usage (root_actor_id, at);
  CREATE INDEX usage_agent ON usage (agent_id, at);

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
    archived_at INTEGER,
    -- JSON: the machine it works on, where there, and the names of its variables. NULL for none.
    machine TEXT,
    -- JSON: the variables its commands are run with, sealed with a key the database never has.
    machine_env TEXT,
    -- For a subagent: the actor that spawned it, the name that actor gave it, and the call of
    -- its model that did. NULL for one that was created from outside.
    parent_id TEXT,
    parent_name TEXT,
    spawned_by TEXT,
    -- JSON: how it is being stopped, and by whom, while it is. What a process looks for when it
    -- starts, to go on stopping it.
    stopping TEXT
  ) STRICT;
  -- An actor's subagents have each a name of their own.
  CREATE UNIQUE INDEX actors_child ON actors (parent_id, parent_name) WHERE parent_id IS NOT NULL;

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
    delivered_at INTEGER,
    -- 1 for one that starts no turn: it waits for a turn something else starts.
    quiet INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  -- An external ID is one input's among its actor's: sending it again stores nothing.
  CREATE UNIQUE INDEX inputs_external_id ON inputs (actor_id, external_id)
    WHERE external_id IS NOT NULL;
  -- What waits: what a turn looks for.
  CREATE INDEX inputs_pending ON inputs (actor_id) WHERE delivered_at IS NULL;
  -- An actor's inputs, as a list of them is read.
  CREATE INDEX inputs_actor ON inputs (actor_id, id);

  -- A task: work an actor's model started that may go on after the call that started it.
  CREATE TABLE tasks (
    actor_id TEXT NOT NULL,
    -- Its kind's letter and its number among its actor's tasks of that kind, such as b3.
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- JSON: what it was started with.
    input TEXT NOT NULL,
    status TEXT NOT NULL,
    stopped_by TEXT,
    -- The tool call that started it: a call that is made again finds its task by it.
    call_id TEXT NOT NULL,
    -- 1 while that call still waits for it.
    attached INTEGER NOT NULL,
    wait_until INTEGER,
    timeout_at INTEGER,
    result TEXT,
    -- The result as a notice carries it, when its kind cut it itself.
    summary TEXT,
    -- JSON: the images whose places are marked in the result. NULL for none.
    images TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    PRIMARY KEY (actor_id, id)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX tasks_call ON tasks (actor_id, call_id);
  -- Those under way: what a start watches again.
  CREATE INDEX tasks_running ON tasks (actor_id) WHERE status = 'running';

  -- A machine: a computer with the daemon on it, where commands run.
  -- An account at a provider of sandboxes.
  CREATE TABLE sandbox_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    -- Which provider it is an account at.
    kind TEXT NOT NULL,
    -- Its credential, sealed with a key the database never has. NULL for a provider that has none.
    credential TEXT,
    -- Who the provider says it belongs to.
    account TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    -- JSON: the IDs of the agents whose actors may work on it, or "*" for every agent.
    agents TEXT NOT NULL,
    -- The SHA-256 of the token its daemon may enrol with, in hex, and until when it works.
    token_hash TEXT,
    token_expires_at INTEGER,
    -- Its daemon's Ed25519 public key, as base64 of its SubjectPublicKeyInfo. NULL until it enrols.
    public_key TEXT,
    -- What its daemon last said of it.
    os TEXT,
    arch TEXT,
    home TEXT,
    hostname TEXT,
    version TEXT,
    -- The SHA-256 of its daemon's program, in hex.
    build TEXT,
    -- The folder its daemon keeps commands in.
    tasks_dir TEXT,
    created_at INTEGER NOT NULL,
    enrolled_at INTEGER,
    last_seen_at INTEGER,
    -- For a sandbox: the provider account it was made in. NULL for a machine someone enrolled.
    provider_id TEXT REFERENCES sandbox_providers (id),
    -- JSON: what it is as a sandbox, but for its account. NULL as its account is.
    sandbox TEXT
  ) STRICT;
  CREATE INDEX machines_provider ON machines (provider_id) WHERE provider_id IS NOT NULL;

  -- A command on a machine, named by the actor and the task it is for. Its row is stored
  -- before the machine is asked to run it, and its ending before the machine is told it arrived.
  CREATE TABLE commands (
    -- The actor it is for, or '_machine' for a machine's own.
    actor_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    -- Seconds it may run. NULL for no limit.
    timeout_s REAL,
    -- starting, running, exited, stopped, failed or lost.
    status TEXT NOT NULL,
    -- 1 once it was asked to be stopped: the asking is sent again when its machine connects.
    stop_wanted INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    stopped_by TEXT,
    ran_ms INTEGER,
    bytes INTEGER,
    lines INTEGER,
    -- The end of what it wrote.
    tail TEXT,
    -- The file all of its output is in, on the machine.
    log TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    PRIMARY KEY (actor_id, task_id)
  ) STRICT, WITHOUT ROWID;

  -- Those that have not ended on a machine: what is settled when its daemon connects.
  CREATE INDEX commands_open ON commands (machine_id)
    WHERE status IN ('starting', 'running');
  -- A machine's own commands, as a list of them is read.
  CREATE INDEX commands_listed ON commands (actor_id, machine_id, started_at);

  -- A blob: an image or file of a conversation, whose bytes are kept in the blob store under
  -- its digest. A row is there while an actor refers to the blob.
  CREATE TABLE blobs (
    -- The SHA-256 of its bytes, in hex.
    digest TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  -- The blobs an actor's conversation and mailbox refer to.
  CREATE TABLE actor_blobs (
    actor_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    -- The media type the actor first gave it: what it is read back as.
    media_type TEXT NOT NULL,
    PRIMARY KEY (actor_id, digest)
  ) STRICT, WITHOUT ROWID;

  -- Whether anything still refers to a blob.
  CREATE INDEX actor_blobs_digest ON actor_blobs (digest);
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
