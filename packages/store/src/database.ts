// What the store does to the database, as plain functions that run to their end at once. They
// are called on the database's own thread (see `worker.ts`), never on the engine's.

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

import type {
  ActorRecord,
  ActorsQuery,
  Change,
  CommandPatch,
  CommandStatus,
  MachinePatch,
  NewCommand,
  StoredCommand,
  Stopping,
  StoredCompaction,
  StoredMachine,
  StoredSandbox,
  StoredSandboxProvider,
  StoredBackupSettings,
  PageOf,
  Paged,
  Redeem,
  SealedSecret,
  NewTask,
  StoredAccount,
  StoredBlob,
  ScriptCall,
  ScriptKept,
  StoredScript,
  StoredTask,
  TaskEnding,
  StoredDeployment,
  StoredKey,
  StoredLink,
  StoredSession,
  StoredUser,
  Turn,
  UsageFilter,
  UsageRecord,
} from '@acentric/core';
import type {
  AccountId,
  Actor,
  ActorId,
  Agent,
  AgentId,
  ConversationEntry,
  Deployment,
  DeploymentId,
  AuditEvent,
  Input,
  InputId,
  InviteId,
  Json,
  Key,
  KeyId,
  MachineAgents,
  MachineId,
  SandboxProviderId,
  Session,
  SessionId,
  UsageGroup,
  UsageReport,
  UsageTotals,
  User,
  UserId,
} from '@acentric/protocol';

/** What the store refuses, in a form that crosses to the engine's thread. */
export class Refused extends Error {
  readonly kind: 'StaleEpoch' | 'NameTaken' | 'OutOfOrder' | 'EmailTaken';
  readonly args: readonly (string | number)[];
  constructor(kind: Refused['kind'], args: readonly (string | number)[]) {
    super(kind);
    this.kind = kind;
    this.args = args;
  }
}

type AgentRow = {
  id: string;
  name: string;
  provider: string;
  active_id: string;
  active_version: number;
  latest_id: string;
  latest_version: number;
  account_id: string | null;
  created_at: number;
};

function agentOf(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    activeDeployment: { id: row.active_id, version: row.active_version },
    latestDeployment: { id: row.latest_id, version: row.latest_version },
    account: row.account_id,
    createdAt: row.created_at,
  } as Agent;
}

/** The sums of the rows of `usage` a query leaves, as one row of it. */
const SUMS = `COUNT(*) AS calls,
  COALESCE(SUM(failure IS NOT NULL), 0) AS failed,
  COALESCE(SUM(total_input), 0) AS total_input,
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(reasoning), 0) AS reasoning,
  COALESCE(SUM(web_searches), 0) AS web_searches,
  COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost ELSE 0 END), 0) AS estimated_cost,
  COALESCE(SUM(failure IS NULL AND cost IS NULL), 0) AS unpriced,
  COALESCE(SUM(duration_ms), 0) AS duration_ms,
  MIN(at) AS first,
  MAX(at) AS last`;

type SumsRow = {
  key?: string | null;
  calls: number;
  failed: number;
  total_input: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  web_searches: number;
  cost: number;
  estimated_cost: number;
  unpriced: number;
  duration_ms: number;
  first: number | null;
  last: number | null;
};

function totalsOfRow(row: SumsRow): UsageTotals {
  return {
    calls: row.calls,
    failed: row.failed,
    totalInput: row.total_input,
    input: row.input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    output: row.output,
    reasoning: row.reasoning,
    webSearches: row.web_searches,
    cost: row.cost,
    estimatedCost: row.estimated_cost,
    unpriced: row.unpriced,
    durationMs: row.duration_ms,
    first: row.first,
    last: row.last,
  };
}

/** What each group of usage is by, as SQLite reads it off a row. */
const GROUP_BY: { readonly [G in UsageGroup]: string } = {
  agent: 'agent_id',
  actor: 'actor_id',
  root: 'root_actor_id',
  account: "COALESCE(account_id, '')",
  provider: 'provider',
  model: 'model',
  // A day in UTC, as the engine names one.
  day: "strftime('%Y-%m-%d', at / 1000, 'unixepoch')",
};

type AccountRow = { account: string; sealed: string };

function accountOf(row: AccountRow): StoredAccount {
  return { account: JSON.parse(row.account) as StoredAccount['account'], sealed: row.sealed };
}

type KeyRow = { id: string; key: string; hash: string; parent: string | null };

function keyOf(row: KeyRow): StoredKey {
  return {
    key: JSON.parse(row.key) as Key,
    hash: row.hash,
    parent: row.parent as KeyId | null,
  };
}

type UserRow = { user: string; password: string };

function userOf(row: UserRow): StoredUser {
  return { user: JSON.parse(row.user) as User, password: row.password };
}

type SecretRow = { agent_id: string; name: string; sealed: string; updated_at: number };

function secretOf(row: SecretRow): SealedSecret {
  return {
    agent: row.agent_id as AgentId,
    name: row.name,
    sealed: row.sealed,
    updatedAt: row.updated_at,
  };
}

type ActorRow = {
  id: string;
  agent_id: string;
  deployment_id: string;
  deployment_version: number;
  pinned: number;
  behind: string | null;
  name: string | null;
  external_id: string | null;
  model: string;
  reasoning: string;
  configuration: string | null;
  configuration_given: string | null;
  sent: string | null;
  reasoning_from: number;
  reasoning_sent: string | null;
  status: string;
  last_turn: string | null;
  turn: string;
  epoch: number;
  next_seq: number;
  created_at: number;
  archived_at: number | null;
  machine: string | null;
  parent_id: string | null;
  parent_name: string | null;
  spawned_by: string | null;
  pending: number;
};

type MachineRow = {
  id: string;
  name: string;
  agents: string;
  token_hash: string | null;
  token_expires_at: number | null;
  public_key: string | null;
  os: string | null;
  arch: string | null;
  home: string | null;
  hostname: string | null;
  version: string | null;
  build: string | null;
  tasks_dir: string | null;
  created_at: number;
  enrolled_at: number | null;
  last_seen_at: number | null;
  provider_id: string | null;
  sandbox: string | null;
};

type BackupSettingsRow = {
  enabled: number;
  every_ms: number;
  keep: number;
  bucket_url: string | null;
  bucket_endpoint: string | null;
  bucket_region: string | null;
  bucket_key_id: string | null;
  bucket_secret: string | null;
  changed_at: number;
  changed_by: string | null;
};

/** The row of backup settings as they are kept. */
function backupSettingsOf(row: BackupSettingsRow): StoredBackupSettings {
  return {
    enabled: row.enabled === 1,
    everyMs: row.every_ms,
    keep: row.keep,
    bucket:
      row.bucket_url === null || row.bucket_key_id === null || row.bucket_secret === null
        ? null
        : {
            url: row.bucket_url,
            endpoint: row.bucket_endpoint,
            region: row.bucket_region,
            accessKeyId: row.bucket_key_id,
            secret: row.bucket_secret,
          },
    changedAt: row.changed_at,
    changedBy: row.changed_by,
  };
}

/**
 * The backup settings of a database read as it is, by a server not running on it, as before a
 * new version changes it. Undefined when they were not set, or the database is from before
 * they could be.
 */
export function readBackupSettings(db: DatabaseSync): StoredBackupSettings | undefined {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_settings'")
    .get();
  if (table === undefined) return undefined;
  const row = db.prepare('SELECT * FROM backup_settings WHERE id = 1').get() as
    BackupSettingsRow | undefined;
  return row === undefined ? undefined : backupSettingsOf(row);
}

type SandboxProviderRow = {
  id: string;
  name: string;
  kind: string;
  credential: string | null;
  account: string | null;
  created_at: number;
};

function sandboxProviderOf(row: SandboxProviderRow): StoredSandboxProvider {
  return {
    id: row.id as SandboxProviderId,
    kind: row.kind,
    name: row.name,
    credential: row.credential,
    account: row.account,
    createdAt: row.created_at,
  };
}

function machineOf(row: MachineRow): StoredMachine {
  return {
    id: row.id,
    name: row.name,
    agents: JSON.parse(row.agents),
    tokenHash: row.token_hash,
    tokenExpiresAt: row.token_expires_at,
    publicKey: row.public_key,
    os: row.os,
    arch: row.arch,
    home: row.home,
    hostname: row.hostname,
    version: row.version,
    build: row.build,
    tasksDir: row.tasks_dir,
    createdAt: row.created_at,
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
    sandbox:
      row.provider_id === null || row.sandbox === null
        ? null
        : { provider: row.provider_id, ...JSON.parse(row.sandbox) },
  } as StoredMachine;
}

/** The column of each field of a machine that changes. */
const MACHINE_COLUMNS: { readonly [F in keyof MachinePatch]-?: string } = {
  name: 'name',
  agents: 'agents',
  tokenHash: 'token_hash',
  tokenExpiresAt: 'token_expires_at',
  publicKey: 'public_key',
  os: 'os',
  arch: 'arch',
  home: 'home',
  hostname: 'hostname',
  version: 'version',
  build: 'build',
  tasksDir: 'tasks_dir',
  enrolledAt: 'enrolled_at',
  lastSeenAt: 'last_seen_at',
  sandbox: 'sandbox',
};

/** What a sandbox's two columns hold: its account, and the rest as JSON. */
function sandboxColumns(sandbox: StoredSandbox | null): [string | null, string | null] {
  if (sandbox === null) return [null, null];
  const { provider, ...rest } = sandbox;
  return [provider, JSON.stringify(rest)];
}

type CommandRow = {
  actor_id: string;
  task_id: string;
  machine_id: string;
  command: string;
  cwd: string;
  timeout_s: number | null;
  status: string;
  stop_wanted: number;
  exit_code: number | null;
  stopped_by: string | null;
  ran_ms: number | null;
  bytes: number | null;
  lines: number | null;
  tail: string | null;
  log: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
};

function commandOf(row: CommandRow): StoredCommand {
  return {
    actor: row.actor_id,
    task: row.task_id,
    machine: row.machine_id,
    command: row.command,
    cwd: row.cwd,
    timeout: row.timeout_s,
    status: row.status,
    stopWanted: row.stop_wanted === 1,
    exit: row.exit_code,
    stoppedBy: row.stopped_by,
    ranMs: row.ran_ms,
    bytes: row.bytes,
    lines: row.lines,
    tail: row.tail,
    log: row.log,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  } as StoredCommand;
}

/** The column of each field of a command that changes. */
const COMMAND_COLUMNS: { readonly [F in keyof CommandPatch]-?: string } = {
  status: 'status',
  stopWanted: 'stop_wanted',
  exit: 'exit_code',
  stoppedBy: 'stopped_by',
  ranMs: 'ran_ms',
  bytes: 'bytes',
  lines: 'lines',
  tail: 'tail',
  log: 'log',
  error: 'error',
  endedAt: 'ended_at',
};

type InputRow = {
  id: string;
  actor_id: string;
  type: string;
  external_id: string | null;
  message: string;
  received_at: number;
  delivered_at: number | null;
  quiet: number;
};

type TaskRow = {
  actor_id: string;
  id: string;
  kind: string;
  input: string;
  status: string;
  stopped_by: string | null;
  call_id: string;
  attached: number;
  wait_until: number | null;
  timeout_at: number | null;
  result: string | null;
  summary: string | null;
  images: string | null;
  started_at: number;
  ended_at: number | null;
};

type ScriptRow = {
  started_at: number;
  seed: number;
  catalog: string;
  ended: string | null;
  value: string | null;
  logs: string | null;
};

type ScriptCallRow = {
  id: number;
  name: string;
  args: string;
  retry_safe: number;
  started_at: number;
  seq: number | null;
  at: number | null;
  outcome: string | null;
};

function scriptOf(row: ScriptRow): StoredScript {
  return {
    startedAt: row.started_at,
    seed: row.seed,
    catalog: JSON.parse(row.catalog) as Json,
    kept:
      row.ended === null
        ? null
        : { ended: row.ended as ScriptKept['ended'], value: row.value, logs: row.logs ?? '' },
  };
}

function taskOf(row: TaskRow): StoredTask {
  return {
    actor: row.actor_id,
    id: row.id,
    kind: row.kind,
    input: JSON.parse(row.input),
    status: row.status,
    stoppedBy: row.stopped_by,
    callId: row.call_id,
    attached: row.attached === 1,
    waitUntil: row.wait_until,
    timeoutAt: row.timeout_at,
    result: row.result,
    summary: row.summary,
    images: row.images === null ? [] : JSON.parse(row.images),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  } as StoredTask;
}

const ACTOR = `SELECT actors.*,
  (SELECT COUNT(*) FROM inputs WHERE actor_id = actors.id AND delivered_at IS NULL) AS pending
  FROM actors`;

function recordOf(row: ActorRow): ActorRecord {
  return {
    actor: {
      id: row.id,
      name: row.name,
      externalId: row.external_id,
      agent: row.agent_id,
      deployment: { id: row.deployment_id, version: row.deployment_version },
      pinned: row.pinned === 1,
      behind: row.behind === null ? null : JSON.parse(row.behind),
      modelId: row.model,
      reasoning: row.reasoning,
      configuration: row.configuration === null ? null : JSON.parse(row.configuration),
      machine: row.machine === null ? null : JSON.parse(row.machine),
      parent: row.parent_id === null ? null : { id: row.parent_id, name: row.parent_name },
      status: row.status,
      lastTurn: row.last_turn === null ? null : JSON.parse(row.last_turn),
      pendingInputs: row.pending,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
    } as Actor,
    turn: JSON.parse(row.turn) as Turn,
    epoch: row.epoch,
    nextSeq: row.next_seq,
    configurationGiven:
      row.configuration_given === null ? null : (JSON.parse(row.configuration_given) as Json),
    sent: row.sent,
    reasoningFrom: row.reasoning_from,
    reasoningSent: row.reasoning_sent as ActorRecord['reasoningSent'],
  };
}

type CompactionRow = { compaction: string; replacement: string };

function compactionOf(row: CompactionRow): StoredCompaction {
  return { ...JSON.parse(row.compaction), replacement: JSON.parse(row.replacement) };
}

function inputOf(row: InputRow): Input {
  return {
    id: row.id,
    actor: row.actor_id,
    type: row.type,
    externalId: row.external_id,
    message: JSON.parse(row.message),
    receivedAt: row.received_at,
    deliveredAt: row.delivered_at,
    ...(row.quiet === 1 ? { quiet: true } : {}),
  } as Input;
}

/** The store's operations on one database. Those in `WRITES` change it. */
export type Operations = ReturnType<typeof operations>;
export type Operation = keyof Operations;

export const WRITES: ReadonlySet<Operation> = new Set([
  'addDeployment',
  'setActive',
  'deleteAgent',
  'deleteActor',
  'freePages',
  'removeExpired',
  'pruneAudit',
  'pruneUsage',
  'setAgentAccount',
  'addAccount',
  'saveAccount',
  'removeAccount',
  'addBlob',
  'dropUnreferencedBlobs',
  'quietInputs',
  'startTask',
  'detachTask',
  'detachTasks',
  'endTask',
  'startScript',
  'endScript',
  'addScriptCall',
  'finishScriptCall',
  'addKey',
  'removeKeys',
  'touchKey',
  'addUser',
  'saveUser',
  'removeUser',
  'addSession',
  'touchSession',
  'removeSession',
  'removeSessions',
  'addLink',
  'removeLink',
  'redeemLink',
  'addAuditEvent',
  'setSecret',
  'deleteSecret',
  'createActor',
  'setStopping',
  'setActorEnv',
  'commit',
  'recordUsage',
  'addInput',
  'addMachine',
  'changeMachine',
  'enrolMachine',
  'removeMachine',
  'saveBackupSettings',
  'addSandboxProvider',
  'removeSandboxProvider',
  'setSandbox',
  'addCommand',
  'addOwnCommand',
  'changeCommand',
]);

export function open(path: string, readOnly: boolean, fullFsync = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    // What is removed is given back to the disk, a little at a time, as the server asks: for a
    // new database, which is made so before anything is written to it; for one made before,
    // once it is vacuumed (`acentric-server compact`), which this asks for.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    // A commit is on the disk before anyone is told of it. Readers do not wait for a writer.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    // On macOS a sync does not reach the disk itself unless it is asked to, at a cost. It makes
    // no difference elsewhere, where a sync always does.
    if (fullFsync) db.exec('PRAGMA fullfsync = ON');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Statements prepared once, for each time they are run again: as many as `most`, past which the
 * one run longest ago is made again when it is next run. Some are made for what they are given,
 * as `IN (?, ?, …)` for a list, or an UPDATE of the columns that change: there is no end to them.
 */
export function preparedStatements(db: DatabaseSync, most = 500) {
  const statements = new Map<string, StatementSync>();
  return {
    get size(): number {
      return statements.size;
    },
    of(sql: string): StatementSync {
      let prepared = statements.get(sql);
      if (prepared === undefined) {
        prepared = db.prepare(sql);
        for (const old of statements.keys()) {
          if (statements.size < most) break;
          statements.delete(old);
        }
      } else {
        // Run: it is the last to go.
        statements.delete(sql);
      }
      statements.set(sql, prepared);
      return prepared;
    },
  };
}

export function operations(db: DatabaseSync) {
  const statements = preparedStatements(db);
  const statement = (sql: string): StatementSync => statements.of(sql);
  const run = (sql: string, ...values: SQLInputValue[]) =>
    Number(statement(sql).run(...values).changes);
  const get = <T>(sql: string, ...values: SQLInputValue[]) =>
    statement(sql).get(...values) as T | undefined;
  const all = <T>(sql: string, ...values: SQLInputValue[]) => statement(sql).all(...values) as T[];

  /** No other account of its provider is the default, when this one is: in the same write. */
  const onlyDefault = (stored: StoredAccount): void => {
    if (!stored.account.default) return;
    run(
      `UPDATE accounts SET account = json_set(account, '$.default', json('false'))
       WHERE id != ? AND json_extract(account, '$.provider') = ?
         AND json_extract(account, '$.default') = 1`,
      stored.account.id,
      stored.account.provider,
    );
  };

  /** An agent's actors, and the subagents under them, of whatever agent, however deep. */
  const treeOf = (id: AgentId): ActorId[] =>
    all<{ id: ActorId }>(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM actors WHERE agent_id = ?
         UNION SELECT actors.id FROM actors JOIN tree ON actors.parent_id = tree.id
       )
       SELECT id FROM tree`,
      id,
    ).map((row) => row.id);

  /** Actors, with everything of theirs: conversations, mailboxes, tasks, scripts, commands. */
  const removeActors = (ids: readonly ActorId[]): void => {
    if (ids.length === 0) return;
    const these = JSON.stringify(ids);
    for (const table of [
      'messages',
      'inputs',
      'actor_blobs',
      'tasks',
      'scripts',
      'script_calls',
      'compactions',
      'commands',
    ]) {
      run(`DELETE FROM ${table} WHERE actor_id IN (SELECT value FROM json_each(?))`, these);
    }
    run('DELETE FROM actors WHERE id IN (SELECT value FROM json_each(?))', these);
  };

  /**
   * A page of rows read one more than was asked for, to know whether there is a next: the
   * items, and the cursor `key` gives of the last of them.
   */
  const paged = <R, T>(
    rows: R[],
    limit: number,
    item: (row: R) => T,
    key: (row: R) => string | number,
  ): Paged<T> => {
    const kept = rows.slice(0, limit);
    const last = kept.at(-1);
    return {
      items: kept.map(item),
      nextCursor: rows.length > limit && last !== undefined ? String(key(last)) : null,
    };
  };
  /** As SQLite takes a limit: one more than asked for, and none for none. */
  const onePast = (page: PageOf | undefined): number =>
    page === undefined || !Number.isFinite(page.limit) ? -1 : page.limit + 1;
  const limitOf = (page: PageOf | undefined): number => page?.limit ?? Number.POSITIVE_INFINITY;

  const nameTaken = (actor: ActorId | null, agent: string, name: string): boolean =>
    get(
      'SELECT 1 FROM actors WHERE agent_id = ? AND name = ? AND id IS NOT ?',
      agent,
      name,
      actor,
    ) !== undefined;

  const command = (actor: string, task: string): CommandRow | undefined =>
    get<CommandRow>('SELECT * FROM commands WHERE actor_id = ? AND task_id = ?', actor, task);

  const task = (actor: ActorId, id: string): TaskRow | undefined =>
    get<TaskRow>('SELECT * FROM tasks WHERE actor_id = ? AND id = ?', actor, id);
  const scriptRow = (actor: ActorId, taskId: string): ScriptRow | undefined =>
    get<ScriptRow>('SELECT * FROM scripts WHERE actor_id = ? AND task_id = ?', actor, taskId);

  /** Puts an input in the mailbox. 0 when its actor has one of its external ID already. */
  const putInput = (input: Input): number =>
    run(
      `INSERT INTO inputs
         (id, actor_id, type, external_id, message, received_at, delivered_at, quiet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (actor_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      input.id,
      input.actor,
      input.type,
      input.externalId,
      JSON.stringify(input.message),
      input.receivedAt,
      input.deliveredAt,
      input.quiet === true ? 1 : 0,
    );
  return {
    addDeployment(given: { agent: Agent; deployment: Deployment; code: string }): void {
      const { agent, deployment, code } = given;
      const there = get<AgentRow>('SELECT * FROM agents WHERE id = ?', agent.id);
      if (
        there === undefined &&
        get('SELECT 1 FROM agents WHERE name = ?', agent.name) !== undefined
      ) {
        throw new Refused('NameTaken', [agent.name, 'agent']);
      }
      if (deployment.version !== (there?.latest_version ?? 0) + 1) {
        throw new Refused('OutOfOrder', [agent.id, deployment.version]);
      }
      run(
        'INSERT INTO deployments (id, agent_id, version, deployment, code) VALUES (?, ?, ?, ?, ?)',
        deployment.id,
        agent.id,
        deployment.version,
        JSON.stringify(deployment),
        code,
      );
      run(
        `INSERT INTO agents (id, name, provider, active_id, active_version, latest_id,
           latest_version, account_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET active_id = excluded.active_id,
           active_version = excluded.active_version, latest_id = excluded.latest_id,
           latest_version = excluded.latest_version`,
        agent.id,
        agent.name,
        agent.provider,
        agent.activeDeployment.id,
        agent.activeDeployment.version,
        agent.latestDeployment.id,
        agent.latestDeployment.version,
        agent.account,
        agent.createdAt,
      );
    },

    setActive(agent: AgentId, version: number): Agent | undefined {
      const deployment = get<{ id: string }>(
        'SELECT id FROM deployments WHERE agent_id = ? AND version = ?',
        agent,
        version,
      );
      if (deployment === undefined) return undefined;
      run(
        'UPDATE agents SET active_id = ?, active_version = ? WHERE id = ?',
        deployment.id,
        version,
        agent,
      );
      const row = get<AgentRow>('SELECT * FROM agents WHERE id = ?', agent);
      return row === undefined ? undefined : agentOf(row);
    },

    loadAgent(id: AgentId): Agent | undefined {
      const row = get<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
      return row === undefined ? undefined : agentOf(row);
    },

    findAgent(name: string): Agent | undefined {
      const row = get<AgentRow>('SELECT * FROM agents WHERE name = ?', name);
      return row === undefined ? undefined : agentOf(row);
    },

    listAgents(page?: PageOf): Paged<Agent> {
      const rows = all<AgentRow>(
        'SELECT * FROM agents WHERE id < ? ORDER BY id DESC LIMIT ?',
        // Above every ID there is, for the first page.
        page?.cursor ?? '~',
        onePast(page),
      );
      return paged(rows, limitOf(page), agentOf, (row) => row.id);
    },

    listDeployments(agent: AgentId, page?: PageOf): Paged<Deployment> {
      const rows = all<{ deployment: string; version: number }>(
        `SELECT deployment, version FROM deployments WHERE agent_id = ? AND version < ?
         ORDER BY version DESC LIMIT ?`,
        agent,
        page?.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(page.cursor),
        onePast(page),
      );
      return paged(
        rows,
        limitOf(page),
        (row) => JSON.parse(row.deployment) as Deployment,
        (row) => row.version,
      );
    },

    agentTree(id: AgentId): ActorId[] {
      return treeOf(id);
    },

    deleteAgent(id: AgentId): { deployments: DeploymentId[]; actors: ActorId[] } | undefined {
      // What its actors worked for goes with them: the subagents of other agents under them too.
      const actors = treeOf(id);
      if (run('DELETE FROM agents WHERE id = ?', id) === 0) return undefined;
      const deployments = all<{ id: DeploymentId }>(
        'DELETE FROM deployments WHERE agent_id = ? RETURNING id',
        id,
      ).map((row) => row.id);
      run('DELETE FROM secrets WHERE agent_id = ?', id);
      removeActors(actors);
      // No machine is for an agent that is gone.
      for (const row of all<{ id: string; agents: string }>('SELECT id, agents FROM machines')) {
        const agents = JSON.parse(row.agents) as MachineAgents;
        if (agents === '*' || !agents.includes(id)) continue;
        run(
          'UPDATE machines SET agents = ? WHERE id = ?',
          JSON.stringify(agents.filter((one) => one !== id)),
          row.id,
        );
      }
      return { deployments, actors };
    },

    deleteActor(id: ActorId): ActorId[] | undefined {
      // The actor, and the subagents under it, however deep.
      const ids = all<{ id: ActorId }>(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM actors WHERE id = ?
           UNION ALL SELECT actors.id FROM actors JOIN tree ON actors.parent_id = tree.id
         )
         SELECT id FROM tree`,
        id,
      ).map((row) => row.id);
      if (ids.length === 0) return undefined;
      removeActors(ids);
      return ids;
    },

    /**
     * Gives the pages nothing is in back to the disk, for a database made to (a new one is):
     * how many bytes went. None, for one that is not.
     */
    freePages(): number {
      const size = (get<{ page_size: number }>('PRAGMA page_size') ?? { page_size: 0 }).page_size;
      const free = () =>
        (get<{ freelist_count: number }>('PRAGMA freelist_count') ?? { freelist_count: 0 })
          .freelist_count;
      const before = free();
      db.exec('PRAGMA incremental_vacuum');
      return (before - free()) * size;
    },

    archivedBefore(before: number, limit: number): ActorId[] {
      return all<{ id: ActorId }>(
        `SELECT id FROM actors
         WHERE archived_at IS NOT NULL AND archived_at < ? AND parent_id IS NULL
         ORDER BY archived_at, id LIMIT ?`,
        before,
        limit,
      ).map((row) => row.id);
    },

    removeExpired(now: number): { sessions: number; links: number } {
      return {
        sessions: run("DELETE FROM sessions WHERE json_extract(session, '$.expiresAt') < ?", now),
        links: run("DELETE FROM links WHERE json_extract(link, '$.expiresAt') < ?", now),
      };
    },

    pruneAudit(before: number, limit: number): number {
      return run(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE json_extract(event, '$.at') < ? ORDER BY id LIMIT ?
         )`,
        before,
        limit,
      );
    },

    pruneUsage(before: number, limit: number): number {
      return run(
        'DELETE FROM usage WHERE rowid IN (SELECT rowid FROM usage WHERE at < ? ORDER BY at LIMIT ?)',
        before,
        limit,
      );
    },

    setAgentAccount(agent: AgentId, account: AccountId | null): Agent | undefined {
      if (run('UPDATE agents SET account_id = ? WHERE id = ?', account, agent) === 0) {
        return undefined;
      }
      const row = get<AgentRow>('SELECT * FROM agents WHERE id = ?', agent);
      return row === undefined ? undefined : agentOf(row);
    },

    addAccount(stored: StoredAccount): void {
      const { id, name } = stored.account;
      if (get('SELECT 1 FROM accounts WHERE name = ?', name) !== undefined) {
        throw new Refused('NameTaken', [name, 'account']);
      }
      run(
        'INSERT INTO accounts (id, name, account, sealed) VALUES (?, ?, ?, ?)',
        id,
        name,
        JSON.stringify(stored.account),
        stored.sealed,
      );
      onlyDefault(stored);
    },

    loadAccount(id: AccountId): StoredAccount | undefined {
      const row = get<AccountRow>('SELECT account, sealed FROM accounts WHERE id = ?', id);
      return row === undefined ? undefined : accountOf(row);
    },

    listAccounts(): StoredAccount[] {
      return all<AccountRow>('SELECT account, sealed FROM accounts ORDER BY id').map(accountOf);
    },

    saveAccount(stored: StoredAccount): void {
      const { id, name } = stored.account;
      if (get('SELECT 1 FROM accounts WHERE name = ? AND id IS NOT ?', name, id) !== undefined) {
        throw new Refused('NameTaken', [name, 'account']);
      }
      run(
        'UPDATE accounts SET name = ?, account = ?, sealed = ? WHERE id = ?',
        name,
        JSON.stringify(stored.account),
        stored.sealed,
        id,
      );
      onlyDefault(stored);
    },

    removeAccount(id: AccountId): void {
      run('DELETE FROM accounts WHERE id = ?', id);
    },

    addBlob(actor: ActorId, blob: StoredBlob): boolean {
      if (get('SELECT 1 FROM actors WHERE id = ?', actor) === undefined) return false;
      run(
        'INSERT INTO blobs (digest, size, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        blob.digest,
        blob.size,
        blob.createdAt,
      );
      run(
        'INSERT INTO actor_blobs (actor_id, digest, media_type) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        actor,
        blob.digest,
        blob.mediaType,
      );
      return true;
    },

    blobOf(actor: ActorId, digest: string): StoredBlob | undefined {
      const row = get<{ size: number; created_at: number; media_type: string }>(
        `SELECT blobs.size, blobs.created_at, actor_blobs.media_type
         FROM actor_blobs JOIN blobs ON blobs.digest = actor_blobs.digest
         WHERE actor_blobs.actor_id = ? AND actor_blobs.digest = ?`,
        actor,
        digest,
      );
      return row === undefined
        ? undefined
        : { digest, size: row.size, mediaType: row.media_type, createdAt: row.created_at };
    },

    dropUnreferencedBlobs(): string[] {
      return all<{ digest: string }>(
        `DELETE FROM blobs
         WHERE NOT EXISTS (SELECT 1 FROM actor_blobs WHERE actor_blobs.digest = blobs.digest)
         RETURNING digest`,
      ).map((row) => row.digest);
    },

    listBlobs(): string[] {
      return all<{ digest: string }>('SELECT digest FROM blobs').map((row) => row.digest);
    },

    agentsOf(account: AccountId): AgentId[] {
      return all<{ id: AgentId }>(
        'SELECT id FROM agents WHERE account_id = ? ORDER BY id',
        account,
      ).map((row) => row.id);
    },

    usage(filter: UsageFilter = {}, by?: UsageGroup): UsageReport {
      const where: string[] = [];
      const values: SQLInputValue[] = [];
      const only = (clause: string, value: string | number | undefined) => {
        if (value === undefined) return;
        where.push(clause);
        values.push(value);
      };
      only('at >= ?', filter.from);
      only('at < ?', filter.to);
      only('agent_id = ?', filter.agent);
      only('actor_id = ?', filter.actor);
      only('root_actor_id = ?', filter.root);
      only('account_id = ?', filter.account);
      only('provider = ?', filter.provider);
      only('model = ?', filter.model);
      only('kind = ?', filter.kind);
      const left = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
      const totals = totalsOfRow(
        get<SumsRow>(`SELECT ${SUMS} FROM usage${left}`, ...values) as SumsRow,
      );
      if (by === undefined) return { totals };
      const groups = all<SumsRow>(
        `SELECT ${GROUP_BY[by]} AS key, ${SUMS} FROM usage${left}
         GROUP BY key ORDER BY cost DESC, key`,
        ...values,
      ).map((row) => ({ key: row.key ?? '', totals: totalsOfRow(row) }));
      return { totals, groups };
    },

    addKey(stored: StoredKey): void {
      run(
        'INSERT INTO keys (id, key, hash, parent) VALUES (?, ?, ?, ?)',
        stored.key.id,
        JSON.stringify(stored.key),
        stored.hash,
        stored.parent,
      );
    },

    loadKey(id: KeyId): StoredKey | undefined {
      const row = get<KeyRow>('SELECT * FROM keys WHERE id = ?', id);
      return row === undefined ? undefined : keyOf(row);
    },

    listKeys(): StoredKey[] {
      return all<KeyRow>('SELECT * FROM keys ORDER BY id').map(keyOf);
    },

    removeKeys(ids: readonly KeyId[]): void {
      for (const id of ids) run('DELETE FROM keys WHERE id = ?', id);
    },

    touchKey(id: KeyId, at: number): void {
      run(`UPDATE keys SET key = json_set(key, '$.lastUsedAt', ?) WHERE id = ?`, at, id);
    },

    loadDeployment(id: DeploymentId): StoredDeployment | undefined {
      const row = get<{ deployment: string; code: string }>(
        'SELECT deployment, code FROM deployments WHERE id = ?',
        id,
      );
      if (row === undefined) return undefined;
      return { deployment: JSON.parse(row.deployment) as Deployment, code: row.code };
    },

    findDeployment(agent: AgentId, version: number): Deployment | undefined {
      const row = get<{ deployment: string }>(
        'SELECT deployment FROM deployments WHERE agent_id = ? AND version = ?',
        agent,
        version,
      );
      return row === undefined ? undefined : (JSON.parse(row.deployment) as Deployment);
    },

    setSecret(secret: SealedSecret): void {
      run(
        `INSERT INTO secrets (agent_id, name, sealed, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_id, name) DO UPDATE SET sealed = excluded.sealed,
           updated_at = excluded.updated_at`,
        secret.agent,
        secret.name,
        secret.sealed,
        secret.updatedAt,
      );
    },

    getSecret(agent: AgentId, name: string): SealedSecret | undefined {
      const row = get<SecretRow>(
        'SELECT * FROM secrets WHERE agent_id = ? AND name = ?',
        agent,
        name,
      );
      return row === undefined ? undefined : secretOf(row);
    },

    secretNames(agent: AgentId): string[] {
      return all<{ name: string }>(
        'SELECT name FROM secrets WHERE agent_id = ? ORDER BY name',
        agent,
      ).map((row) => row.name);
    },

    deleteSecret(agent: AgentId, name: string): boolean {
      return run('DELETE FROM secrets WHERE agent_id = ? AND name = ?', agent, name) > 0;
    },

    allSecrets(): SealedSecret[] {
      return all<SecretRow>('SELECT * FROM secrets ORDER BY agent_id, name').map(secretOf);
    },

    addUser(stored: StoredUser): void {
      const { user } = stored;
      if (get('SELECT 1 FROM users WHERE email = ?', user.email) !== undefined) {
        throw new Refused('EmailTaken', [user.email]);
      }
      run(
        'INSERT INTO users (id, email, user, password) VALUES (?, ?, ?, ?)',
        user.id,
        user.email,
        JSON.stringify(user),
        stored.password,
      );
    },

    loadUser(id: UserId): StoredUser | undefined {
      const row = get<UserRow>('SELECT user, password FROM users WHERE id = ?', id);
      return row === undefined ? undefined : userOf(row);
    },

    findUser(email: string): StoredUser | undefined {
      const row = get<UserRow>('SELECT user, password FROM users WHERE email = ?', email);
      return row === undefined ? undefined : userOf(row);
    },

    listUsers(): User[] {
      return all<UserRow>('SELECT user, password FROM users ORDER BY id').map(
        (row) => userOf(row).user,
      );
    },

    saveUser(stored: StoredUser): void {
      run(
        'UPDATE users SET email = ?, user = ?, password = ? WHERE id = ?',
        stored.user.email,
        JSON.stringify(stored.user),
        stored.password,
        stored.user.id,
      );
    },

    removeUser(id: UserId): void {
      run('DELETE FROM users WHERE id = ?', id);
      run('DELETE FROM sessions WHERE user_id = ?', id);
    },

    addSession(stored: StoredSession): void {
      run(
        'INSERT INTO sessions (id, user_id, session, hash) VALUES (?, ?, ?, ?)',
        stored.session.id,
        stored.session.user,
        JSON.stringify(stored.session),
        stored.hash,
      );
    },

    loadSession(id: SessionId): StoredSession | undefined {
      const row = get<{ session: string; hash: string }>(
        'SELECT session, hash FROM sessions WHERE id = ?',
        id,
      );
      if (row === undefined) return undefined;
      return { session: JSON.parse(row.session) as Session, hash: row.hash };
    },

    listSessions(user: UserId): Session[] {
      return all<{ session: string }>(
        'SELECT session FROM sessions WHERE user_id = ? ORDER BY id',
        user,
      ).map((row) => JSON.parse(row.session) as Session);
    },

    touchSession(id: SessionId, lastUsedAt: number, expiresAt: number): void {
      run(
        `UPDATE sessions SET session = json_set(session, '$.lastUsedAt', ?, '$.expiresAt', ?)
         WHERE id = ?`,
        lastUsedAt,
        expiresAt,
        id,
      );
    },

    removeSession(id: SessionId): void {
      run('DELETE FROM sessions WHERE id = ?', id);
    },

    removeSessions(user: UserId, keep?: SessionId): void {
      run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', user, keep ?? null);
    },

    addLink(link: StoredLink): void {
      run(
        'INSERT INTO links (id, kind, link) VALUES (?, ?, ?)',
        link.id,
        link.kind,
        JSON.stringify(link),
      );
    },

    loadLink(id: InviteId): StoredLink | undefined {
      const row = get<{ link: string }>('SELECT link FROM links WHERE id = ?', id);
      return row === undefined ? undefined : (JSON.parse(row.link) as StoredLink);
    },

    listLinks(kind: StoredLink['kind']): StoredLink[] {
      return all<{ link: string }>('SELECT link FROM links WHERE kind = ? ORDER BY id', kind).map(
        (row) => JSON.parse(row.link) as StoredLink,
      );
    },

    removeLink(id: InviteId): boolean {
      return run('DELETE FROM links WHERE id = ?', id) > 0;
    },

    redeemLink(id: InviteId, redeem: Redeem): 'done' | 'gone' {
      if (get('SELECT 1 FROM links WHERE id = ?', id) === undefined) return 'gone';
      if ('addUser' in redeem) {
        const { user } = redeem.addUser;
        // Refused before anything is written, so that the link stays for another try.
        if (get('SELECT 1 FROM users WHERE email = ?', user.email) !== undefined) {
          throw new Refused('EmailTaken', [user.email]);
        }
        run(
          'INSERT INTO users (id, email, user, password) VALUES (?, ?, ?, ?)',
          user.id,
          user.email,
          JSON.stringify(user),
          redeem.addUser.password,
        );
      } else {
        const { user, password } = redeem.setPassword;
        run('UPDATE users SET password = ? WHERE id = ?', password, user);
      }
      run('DELETE FROM links WHERE id = ?', id);
      return 'done';
    },

    addAuditEvent(event: AuditEvent): void {
      run(
        'INSERT INTO audit_events (id, action, event) VALUES (?, ?, ?)',
        event.id,
        event.action,
        JSON.stringify(event),
      );
    },

    listAuditEvents(
      query: PageOf & { action?: string } = { limit: Number.POSITIVE_INFINITY },
    ): Paged<AuditEvent> {
      const of = query.action === undefined ? '' : ' AND action = ?';
      const rows = all<{ id: string; event: string }>(
        `SELECT id, event FROM audit_events WHERE id < ?${of} ORDER BY id DESC LIMIT ?`,
        query.cursor ?? '~',
        ...(query.action === undefined ? [] : [query.action]),
        onePast(query),
      );
      return paged(
        rows,
        limitOf(query),
        (row) => JSON.parse(row.event) as AuditEvent,
        (row) => row.id,
      );
    },

    createActor(
      actor: Actor,
      configurationGiven: Json | null = null,
      env: string | null = null,
      spawnedBy: string | null = null,
    ): { record: ActorRecord; created: boolean } {
      if (
        actor.parent !== null &&
        get(
          'SELECT 1 FROM actors WHERE parent_id = ? AND parent_name = ?',
          actor.parent.id,
          actor.parent.name,
        ) !== undefined
      ) {
        throw new Refused('NameTaken', [actor.parent.name, 'subagent']);
      }
      if (actor.externalId !== null) {
        const there = get<ActorRow>(
          `${ACTOR} WHERE agent_id = ? AND external_id = ?`,
          actor.agent,
          actor.externalId,
        );
        if (there !== undefined) return { record: recordOf(there), created: false };
      }
      if (actor.name !== null && nameTaken(null, actor.agent, actor.name)) {
        throw new Refused('NameTaken', [actor.name, 'actor']);
      }
      const turn: Turn = { phase: 'idle' };
      run(
        `INSERT INTO actors (id, agent_id, deployment_id, deployment_version, pinned, behind, name, external_id,
           model, reasoning, configuration, configuration_given, sent, reasoning_from, status,
           last_turn, turn, owed, epoch, next_seq, created_at, archived_at, machine, machine_env,
           parent_id, parent_name, spawned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
        actor.id,
        actor.agent,
        actor.deployment.id,
        actor.deployment.version,
        actor.pinned ? 1 : 0,
        actor.behind === null ? null : JSON.stringify(actor.behind),
        actor.name,
        actor.externalId,
        actor.modelId,
        actor.reasoning,
        actor.configuration === null ? null : JSON.stringify(actor.configuration),
        configurationGiven === null ? null : JSON.stringify(configurationGiven),
        actor.status,
        actor.lastTurn === null ? null : JSON.stringify(actor.lastTurn),
        JSON.stringify(turn),
        actor.createdAt,
        actor.archivedAt,
        actor.machine === null ? null : JSON.stringify(actor.machine),
        env,
        actor.parent?.id ?? null,
        actor.parent?.name ?? null,
        spawnedBy,
      );
      return {
        record: {
          actor: { ...actor, pendingInputs: 0 },
          turn,
          epoch: 0,
          nextSeq: 1,
          configurationGiven,
          sent: null,
          reasoningFrom: 1,
          reasoningSent: null,
        },
        created: true,
      };
    },

    actorEnv(actor: ActorId): string | null {
      return (
        get<{ machine_env: string | null }>('SELECT machine_env FROM actors WHERE id = ?', actor)
          ?.machine_env ?? null
      );
    },

    setActorEnv(actor: ActorId, names: readonly string[], sealed: string | null): boolean {
      const row = get<{ machine: string | null }>('SELECT machine FROM actors WHERE id = ?', actor);
      if (row === undefined || row.machine === null) return false;
      const machine = { ...(JSON.parse(row.machine) as object), env: [...names] };
      run(
        'UPDATE actors SET machine = ?, machine_env = ? WHERE id = ?',
        JSON.stringify(machine),
        sealed,
        actor,
      );
      return true;
    },

    loadActor(id: ActorId): ActorRecord | undefined {
      const row = get<ActorRow>(`${ACTOR} WHERE id = ?`, id);
      return row === undefined ? undefined : recordOf(row);
    },

    findActor(agent: AgentId, externalId: string): ActorRecord | undefined {
      const row = get<ActorRow>(
        `${ACTOR} WHERE agent_id = ? AND external_id = ?`,
        agent,
        externalId,
      );
      return row === undefined ? undefined : recordOf(row);
    },

    listActors(query: ActorsQuery = { limit: Number.POSITIVE_INFINITY }): Paged<Actor> {
      const where: string[] = ['id < ?'];
      const values: SQLInputValue[] = [query.cursor ?? '~'];
      const only = (column: string, value: string | undefined) => {
        if (value === undefined) return;
        where.push(`${column} = ?`);
        values.push(value);
      };
      only('agent_id', query.agent);
      only('id', query.actor);
      only('status', query.status);
      only('name', query.name);
      only('external_id', query.externalId);
      only('parent_id', query.parent);
      const rows = all<ActorRow>(
        `${ACTOR} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        ...values,
        onePast(query),
      );
      return paged(
        rows,
        limitOf(query),
        (row) => recordOf(row).actor,
        (row) => row.id,
      );
    },

    recordUsage(used: UsageRecord): void {
      /** The actor at the top of an actor's tree of subagents: itself, for one created from outside. */
      const rootOf = (actor: ActorId): ActorId => {
        let top = actor;
        for (;;) {
          const row = get<{ parent_id: ActorId | null }>(
            'SELECT parent_id FROM actors WHERE id = ?',
            top,
          );
          if (row === undefined || row.parent_id === null) return top;
          top = row.parent_id;
        }
      };
      const counted = used.usage;
      run(
        `INSERT INTO usage (at, actor_id, root_actor_id, kind, agent_id, version, account_id,
           provider, model, failure, total_input, input, output, reasoning, cache_read,
           cache_write, web_searches, cost, cost_source, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        used.at,
        used.actor,
        rootOf(used.actor),
        used.kind ?? 'turn',
        used.agent,
        used.version,
        used.account,
        used.provider,
        used.model,
        used.failure,
        counted?.totalInput ?? 0,
        counted?.input ?? 0,
        counted?.output ?? 0,
        counted?.reasoning ?? 0,
        counted?.cacheRead ?? 0,
        counted?.cacheWrite ?? 0,
        counted?.webSearches ?? 0,
        counted?.cost?.total ?? null,
        counted?.cost?.source ?? null,
        used.durationMs,
      );
    },

    latestCompaction(actor: ActorId): StoredCompaction | undefined {
      const row = get<CompactionRow>(
        'SELECT compaction, replacement FROM compactions WHERE actor_id = ? ORDER BY at_seq DESC LIMIT 1',
        actor,
      );
      return row === undefined ? undefined : compactionOf(row);
    },

    listCompactions(actor: ActorId): StoredCompaction[] {
      return all<CompactionRow>(
        'SELECT compaction, replacement FROM compactions WHERE actor_id = ? ORDER BY at_seq DESC',
        actor,
      ).map(compactionOf);
    },

    commit(id: ActorId, epoch: number, change: Change): void {
      // What of the actor itself changes, each as the column it is and what goes in it.
      const { set, sent } = change;
      const json = (value: Json | null | undefined) =>
        value === null || value === undefined ? null : JSON.stringify(value);
      const more: [string, SQLInputValue][] = [];
      if (set !== null) {
        if (set.name !== undefined) more.push(['name', set.name]);
        if (set.modelId !== undefined) more.push(['model', set.modelId]);
        if (set.reasoning !== undefined) more.push(['reasoning', set.reasoning]);
        if (set.configuration !== undefined) more.push(['configuration', json(set.configuration)]);
        if (set.configurationGiven !== undefined) {
          more.push(['configuration_given', json(set.configurationGiven)]);
        }
        if (set.deployment !== undefined) {
          more.push(['deployment_id', set.deployment.id]);
          more.push(['deployment_version', set.deployment.version]);
        }
        if (set.reasoningSent !== undefined) more.push(['reasoning_sent', set.reasoningSent]);
        if (set.pinned !== undefined) more.push(['pinned', set.pinned ? 1 : 0]);
        if (set.behind !== undefined) more.push(['behind', json(set.behind)]);
      }
      if (sent !== null) {
        more.push(['sent', sent.fingerprint]);
        more.push(['reasoning_from', sent.reasoningFrom]);
      }
      if (typeof set?.name === 'string') {
        const named = get<{ agent_id: string; epoch: number }>(
          'SELECT agent_id, epoch FROM actors WHERE id = ?',
          id,
        );
        // Only of a step that would be stored: one that read an epoch since passed is told that.
        if (named?.epoch === epoch && nameTaken(id, named.agent_id, set.name)) {
          throw new Refused('NameTaken', [set.name, 'actor']);
        }
      }
      const changed = run(
        `UPDATE actors SET status = ?, last_turn = ?, archived_at = ?, turn = ?, owed = ?,
           epoch = epoch + 1, next_seq = next_seq + ?${more.map(([column]) => `, ${column} = ?`).join('')}
         WHERE id = ? AND epoch = ?`,
        change.status,
        change.lastTurn === null ? null : JSON.stringify(change.lastTurn),
        change.archivedAt,
        JSON.stringify(change.turn),
        change.turn.phase === 'idle' ? 0 : 1,
        change.append.length,
        ...more.map(([, value]) => value),
        id,
        epoch,
      );
      if (changed === 0) {
        const row = get<{ epoch: number }>('SELECT epoch FROM actors WHERE id = ?', id);
        if (row === undefined) throw new Error(`There is no actor ${id}`);
        throw new Refused('StaleEpoch', [id, epoch, row.epoch]);
      }
      if (change.usage !== null) this.recordUsage(change.usage);
      if (change.compaction !== undefined) {
        const { replacement, ...compaction } = change.compaction;
        run(
          `INSERT INTO compactions (actor_id, at_seq, compaction, replacement) VALUES (?, ?, ?, ?)`,
          id,
          compaction.atSeq,
          JSON.stringify(compaction),
          JSON.stringify(replacement),
        );
      }
      for (const entry of change.append) {
        run(
          'INSERT INTO messages (actor_id, seq, entry) VALUES (?, ?, ?)',
          id,
          entry.seq,
          JSON.stringify(entry),
        );
      }
      if (change.leaveOutFrom !== null) {
        run(
          `UPDATE messages SET entry = json_set(entry, '$.leftOut', json('true'))
           WHERE actor_id = ? AND seq >= ?`,
          id,
          change.leaveOutFrom,
        );
      }
      for (const input of change.deliver) {
        run(
          'UPDATE inputs SET delivered_at = ? WHERE id = ? AND actor_id = ?',
          change.at,
          input,
          id,
        );
      }
    },

    addInput(input: Input): 'accepted' | 'duplicate' {
      return putInput(input) === 0 ? 'duplicate' : 'accepted';
    },

    findInput(actor: ActorId, externalId: string): InputId | undefined {
      const row = get<{ id: InputId }>(
        'SELECT id FROM inputs WHERE actor_id = ? AND external_id = ?',
        actor,
        externalId,
      );
      return row?.id;
    },

    pendingInputs(actor: ActorId): Input[] {
      return all<InputRow>(
        'SELECT * FROM inputs WHERE actor_id = ? AND delivered_at IS NULL ORDER BY rowid',
        actor,
      ).map(inputOf);
    },

    listInputs(
      actor: ActorId,
      query: PageOf & { pending?: boolean } = { limit: Number.POSITIVE_INFINITY },
    ): Paged<Input> {
      const which =
        query.pending === undefined
          ? ''
          : query.pending
            ? ' AND delivered_at IS NULL'
            : ' AND delivered_at IS NOT NULL';
      const rows = all<InputRow>(
        `SELECT * FROM inputs WHERE actor_id = ? AND id < ?${which} ORDER BY id DESC LIMIT ?`,
        actor,
        query.cursor ?? '~',
        onePast(query),
      );
      return paged(rows, limitOf(query), inputOf, (row) => row.id);
    },

    conversation(
      actor: ActorId,
      part: { after?: number; before?: number; limit?: number; order?: 'asc' | 'desc' } = {},
    ): ConversationEntry[] {
      return all<{ entry: string }>(
        `SELECT entry FROM messages WHERE actor_id = ? AND seq > ? AND seq < ?
         ORDER BY seq ${part.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        actor,
        part.after ?? 0,
        part.before ?? Number.MAX_SAFE_INTEGER,
        // SQLite reads a limit below zero as none.
        part.limit ?? -1,
      ).map((row) => JSON.parse(row.entry) as ConversationEntry);
    },

    quietInputs(actor: ActorId, only?: readonly string[]): void {
      if (only === undefined) {
        run('UPDATE inputs SET quiet = 1 WHERE actor_id = ? AND delivered_at IS NULL', actor);
        return;
      }
      for (const type of only) {
        run(
          'UPDATE inputs SET quiet = 1 WHERE actor_id = ? AND delivered_at IS NULL AND type = ?',
          actor,
          type,
        );
      }
    },

    unfinished(): ActorId[] {
      return all<{ id: ActorId }>(
        `SELECT id FROM actors WHERE owed = 1
         UNION SELECT actor_id FROM inputs WHERE delivered_at IS NULL AND quiet = 0`,
      ).map((row) => row.id);
    },

    startTask(given: NewTask): StoredTask {
      const started = get<TaskRow>(
        'SELECT * FROM tasks WHERE actor_id = ? AND call_id = ?',
        given.actor,
        given.callId,
      );
      if (started !== undefined) return taskOf(started);
      const counted = get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM tasks WHERE actor_id = ? AND kind = ?',
        given.actor,
        given.kind,
      );
      const id = `${given.prefix}${String((counted?.count ?? 0) + 1)}`;
      run(
        `INSERT INTO tasks
           (actor_id, id, kind, input, status, call_id, attached, wait_until, timeout_at, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        given.actor,
        id,
        given.kind,
        JSON.stringify(given.input),
        given.callId,
        given.attached ? 1 : 0,
        given.waitUntil,
        given.timeoutAt,
        given.startedAt,
      );
      return taskOf(task(given.actor, id) as TaskRow);
    },

    startScript(
      actor: ActorId,
      taskId: string,
      script: Pick<StoredScript, 'startedAt' | 'seed' | 'catalog'>,
    ): StoredScript {
      run(
        `INSERT INTO scripts (actor_id, task_id, started_at, seed, catalog) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (actor_id, task_id) DO NOTHING`,
        actor,
        taskId,
        script.startedAt,
        script.seed,
        JSON.stringify(script.catalog),
      );
      return scriptOf(scriptRow(actor, taskId) as ScriptRow);
    },

    loadScript(actor: ActorId, taskId: string): StoredScript | undefined {
      const row = scriptRow(actor, taskId);
      return row === undefined ? undefined : scriptOf(row);
    },

    endScript(actor: ActorId, taskId: string, kept: ScriptKept): void {
      run(
        'UPDATE scripts SET ended = ?, value = ?, logs = ? WHERE actor_id = ? AND task_id = ?',
        kept.ended,
        kept.value,
        kept.logs,
        actor,
        taskId,
      );
    },

    listScriptCalls(actor: ActorId, taskId: string): ScriptCall[] {
      return all<ScriptCallRow>(
        'SELECT * FROM script_calls WHERE actor_id = ? AND task_id = ? ORDER BY id',
        actor,
        taskId,
      ).map((row) => ({
        id: row.id,
        name: row.name,
        args: row.args,
        retrySafe: row.retry_safe === 1,
        startedAt: row.started_at,
        done:
          row.seq === null
            ? null
            : {
                seq: row.seq,
                at: row.at ?? row.started_at,
                outcome: JSON.parse(row.outcome ?? 'null') as Json,
              },
      }));
    },

    addScriptCall(actor: ActorId, taskId: string, call: Omit<ScriptCall, 'done'>): void {
      run(
        `INSERT INTO script_calls (actor_id, task_id, id, name, args, retry_safe, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (actor_id, task_id, id) DO NOTHING`,
        actor,
        taskId,
        call.id,
        call.name,
        call.args,
        call.retrySafe ? 1 : 0,
        call.startedAt,
      );
    },

    finishScriptCall(
      actor: ActorId,
      taskId: string,
      id: number,
      done: NonNullable<ScriptCall['done']>,
    ): void {
      run(
        `UPDATE script_calls SET seq = ?, at = ?, outcome = ?
         WHERE actor_id = ? AND task_id = ? AND id = ?`,
        done.seq,
        done.at,
        JSON.stringify(done.outcome),
        actor,
        taskId,
        id,
      );
    },

    loadTask(actor: ActorId, id: string): StoredTask | undefined {
      const row = task(actor, id);
      return row === undefined ? undefined : taskOf(row);
    },

    taskOfCall(actor: ActorId, callId: string): StoredTask | undefined {
      const row = get<TaskRow>(
        'SELECT * FROM tasks WHERE actor_id = ? AND call_id = ?',
        actor,
        callId,
      );
      return row === undefined ? undefined : taskOf(row);
    },

    listTasks(actor: ActorId, query: { readonly running?: boolean } = {}): StoredTask[] {
      return all<TaskRow>(
        `SELECT * FROM tasks WHERE actor_id = ? ${query.running === true ? "AND status = 'running'" : ''}
         ORDER BY started_at DESC, length(id) DESC, id DESC`,
        actor,
      ).map(taskOf);
    },

    runningTasks(): StoredTask[] {
      return all<TaskRow>(
        "SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at, actor_id, id",
      ).map(taskOf);
    },

    detachTask(actor: ActorId, id: string): boolean {
      const changed = run(
        "UPDATE tasks SET attached = 0 WHERE actor_id = ? AND id = ? AND status = 'running' AND attached = 1",
        actor,
        id,
      );
      return changed === 1;
    },

    detachTasks(actor: ActorId): StoredTask[] {
      return all<TaskRow>(
        `UPDATE tasks SET attached = 0
         WHERE actor_id = ? AND status = 'running' AND attached = 1 RETURNING *`,
        actor,
      ).map(taskOf);
    },

    endTask(
      actor: ActorId,
      id: string,
      end: TaskEnding,
      notice: Input | null,
    ): { ended: boolean; notified: boolean } {
      const row = task(actor, id);
      if (row?.status !== 'running') return { ended: false, notified: false };
      run(
        `UPDATE tasks SET status = ?, stopped_by = ?, result = ?, summary = ?, images = ?, ended_at = ?
         WHERE actor_id = ? AND id = ?`,
        end.status,
        end.stoppedBy,
        end.result,
        end.summary,
        end.images.length === 0 ? null : JSON.stringify(end.images),
        end.endedAt,
        actor,
        id,
      );
      // A task its call still waits for is told by that call's result, and by nothing else.
      if (notice === null || row.attached === 1) return { ended: true, notified: false };
      if (get('SELECT 1 FROM actors WHERE id = ?', actor) === undefined) {
        return { ended: true, notified: false };
      }
      putInput(notice);
      return { ended: true, notified: true };
    },

    addMachine(machine: StoredMachine): void {
      if (get('SELECT 1 FROM machines WHERE name = ?', machine.name) !== undefined) {
        throw new Refused('NameTaken', [machine.name, 'machine']);
      }
      run(
        `INSERT INTO machines (id, name, agents, token_hash, token_expires_at, public_key, os, arch,
           home, hostname, version, build, tasks_dir, created_at, enrolled_at, last_seen_at,
           provider_id, sandbox)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        machine.id,
        machine.name,
        JSON.stringify(machine.agents),
        machine.tokenHash,
        machine.tokenExpiresAt,
        machine.publicKey,
        machine.os,
        machine.arch,
        machine.home,
        machine.hostname,
        machine.version,
        machine.build,
        machine.tasksDir,
        machine.createdAt,
        machine.enrolledAt,
        machine.lastSeenAt,
        ...sandboxColumns(machine.sandbox),
      );
    },

    loadMachine(id: MachineId): StoredMachine | undefined {
      const row = get<MachineRow>('SELECT * FROM machines WHERE id = ?', id);
      return row === undefined ? undefined : machineOf(row);
    },

    findMachine(name: string): StoredMachine | undefined {
      const row = get<MachineRow>('SELECT * FROM machines WHERE name = ?', name);
      return row === undefined ? undefined : machineOf(row);
    },

    listMachines(): StoredMachine[] {
      return all<MachineRow>('SELECT * FROM machines ORDER BY created_at, id').map(machineOf);
    },

    machinesOfActors(query: {
      readonly agents: readonly AgentId[];
      readonly actors: readonly ActorId[];
    }): MachineId[] {
      if (query.agents.length === 0 && query.actors.length === 0) return [];
      const marks = (count: number) => (count === 0 ? 'NULL' : Array(count).fill('?').join(', '));
      return all<{ machine: MachineId }>(
        `SELECT DISTINCT json_extract(machine, '$.id') AS machine FROM actors
         WHERE machine IS NOT NULL
           AND ((agent_id IN (${marks(query.agents.length)}) AND status != 'archived')
             OR id IN (${marks(query.actors.length)}))`,
        ...query.agents,
        ...query.actors,
      ).map((row) => row.machine);
    },

    changeMachine(id: MachineId, patch: MachinePatch): StoredMachine | undefined {
      if (get('SELECT 1 FROM machines WHERE id = ?', id) === undefined) return undefined;
      if (
        patch.name !== undefined &&
        get('SELECT 1 FROM machines WHERE name = ? AND id IS NOT ?', patch.name, id) !== undefined
      ) {
        throw new Refused('NameTaken', [patch.name, 'machine']);
      }
      const sets: string[] = [];
      const values: SQLInputValue[] = [];
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (field === 'sandbox') {
          sets.push('provider_id = ?', 'sandbox = ?');
          values.push(...sandboxColumns(value as StoredSandbox | null));
          continue;
        }
        sets.push(`${MACHINE_COLUMNS[field as keyof MachinePatch]} = ?`);
        values.push(field === 'agents' ? JSON.stringify(value) : (value as SQLInputValue));
      }
      if (sets.length > 0)
        run(`UPDATE machines SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
      return machineOf(get<MachineRow>('SELECT * FROM machines WHERE id = ?', id) as MachineRow);
    },

    enrolMachine(id: MachineId, tokenHash: string, publicKey: string, at: number): boolean {
      const changed = run(
        `UPDATE machines
         SET public_key = ?, token_hash = NULL, token_expires_at = NULL, enrolled_at = ?
         WHERE id = ? AND token_hash = ? AND token_expires_at > ?`,
        publicKey,
        at,
        id,
        tokenHash,
        at,
      );
      return changed === 1;
    },

    removeMachine(
      id: MachineId,
      lost: { readonly error: string; readonly endedAt: number },
    ): StoredCommand[] | undefined {
      if (run('DELETE FROM machines WHERE id = ?', id) === 0) return undefined;
      const unended = all<CommandRow>(
        "SELECT * FROM commands WHERE machine_id = ? AND status IN ('starting', 'running')",
        id,
      ).map(commandOf);
      run(
        `UPDATE commands SET status = 'lost', error = ?, ended_at = ?
         WHERE machine_id = ? AND status IN ('starting', 'running')`,
        lost.error,
        lost.endedAt,
        id,
      );
      return unended;
    },

    findChild(
      parent: ActorId,
      name: string,
    ): { actor: Actor; spawnedBy: string | null } | undefined {
      const row = get<ActorRow>(`${ACTOR} WHERE parent_id = ? AND parent_name = ?`, parent, name);
      return row === undefined
        ? undefined
        : { actor: recordOf(row).actor, spawnedBy: row.spawned_by };
    },

    listChildren(parent: ActorId): Actor[] {
      return all<ActorRow>(`${ACTOR} WHERE parent_id = ? ORDER BY created_at, id`, parent).map(
        (row) => recordOf(row).actor,
      );
    },

    setStopping(actor: ActorId, stopping: Stopping | null): void {
      run(
        'UPDATE actors SET stopping = ? WHERE id = ?',
        stopping === null ? null : JSON.stringify(stopping),
        actor,
      );
    },

    listStopping(): ({ actor: ActorId } & Stopping)[] {
      return all<{ id: ActorId; stopping: string }>(
        'SELECT id, stopping FROM actors WHERE stopping IS NOT NULL ORDER BY created_at, id',
      ).map((row) => ({ actor: row.id, ...(JSON.parse(row.stopping) as Stopping) }));
    },

    loadBackupSettings(): StoredBackupSettings | undefined {
      const row = get<BackupSettingsRow>('SELECT * FROM backup_settings WHERE id = 1');
      return row === undefined ? undefined : backupSettingsOf(row);
    },

    saveBackupSettings(settings: StoredBackupSettings): void {
      const { bucket } = settings;
      run(
        `INSERT OR REPLACE INTO backup_settings (id, enabled, every_ms, keep, bucket_url,
           bucket_endpoint, bucket_region, bucket_key_id, bucket_secret, changed_at, changed_by)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        settings.enabled ? 1 : 0,
        settings.everyMs,
        settings.keep,
        bucket?.url ?? null,
        bucket?.endpoint ?? null,
        bucket?.region ?? null,
        bucket?.accessKeyId ?? null,
        bucket?.secret ?? null,
        settings.changedAt,
        settings.changedBy,
      );
    },

    addSandboxProvider(provider: StoredSandboxProvider): void {
      if (get('SELECT 1 FROM sandbox_providers WHERE name = ?', provider.name) !== undefined) {
        throw new Refused('NameTaken', [provider.name, 'provider account']);
      }
      run(
        `INSERT INTO sandbox_providers (id, name, kind, credential, account, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        provider.id,
        provider.name,
        provider.kind,
        provider.credential,
        provider.account,
        provider.createdAt,
      );
    },

    loadSandboxProvider(id: SandboxProviderId): StoredSandboxProvider | undefined {
      const row = get<SandboxProviderRow>('SELECT * FROM sandbox_providers WHERE id = ?', id);
      return row === undefined ? undefined : sandboxProviderOf(row);
    },

    listSandboxProviders(): StoredSandboxProvider[] {
      return all<SandboxProviderRow>('SELECT * FROM sandbox_providers ORDER BY created_at, id').map(
        sandboxProviderOf,
      );
    },

    removeSandboxProvider(id: SandboxProviderId): 'removed' | 'in_use' | 'missing' {
      if (get('SELECT 1 FROM sandbox_providers WHERE id = ?', id) === undefined) return 'missing';
      if (get('SELECT 1 FROM machines WHERE provider_id = ?', id) !== undefined) return 'in_use';
      run('DELETE FROM sandbox_providers WHERE id = ?', id);
      return 'removed';
    },

    setSandbox(id: MachineId, sandbox: StoredSandbox): boolean {
      if (get('SELECT 1 FROM sandbox_providers WHERE id = ?', sandbox.provider) === undefined) {
        return false;
      }
      const changed = run(
        'UPDATE machines SET provider_id = ?, sandbox = ? WHERE id = ?',
        ...sandboxColumns(sandbox),
        id,
      );
      return changed === 1;
    },

    addCommand(given: NewCommand): { command: StoredCommand; created: boolean } {
      const there = command(given.actor, given.task);
      if (there !== undefined) return { command: commandOf(there), created: false };
      run(
        `INSERT INTO commands (actor_id, task_id, machine_id, command, cwd, timeout_s, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'starting', ?)`,
        given.actor,
        given.task,
        given.machine,
        given.command,
        given.cwd,
        given.timeout,
        given.startedAt,
      );
      return { command: commandOf(command(given.actor, given.task) as CommandRow), created: true };
    },

    addOwnCommand(given: Omit<NewCommand, 'task'>): StoredCommand {
      const counted = get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM commands WHERE actor_id = ?',
        given.actor,
      );
      const id = `c${String((counted?.count ?? 0) + 1)}`;
      return this.addCommand({ ...given, task: id }).command;
    },

    loadCommand(actor: string, id: string): StoredCommand | undefined {
      const row = command(actor, id);
      return row === undefined ? undefined : commandOf(row);
    },

    openCommands(machine: MachineId): StoredCommand[] {
      return all<CommandRow>(
        `SELECT * FROM commands WHERE machine_id = ? AND status IN ('starting', 'running')
         ORDER BY started_at, actor_id, task_id`,
        machine,
      ).map(commandOf);
    },

    listCommands(actor: string, machine: MachineId, limit: number): StoredCommand[] {
      return all<CommandRow>(
        `SELECT * FROM commands WHERE actor_id = ? AND machine_id = ?
         ORDER BY started_at DESC, length(task_id) DESC, task_id DESC LIMIT ?`,
        actor,
        machine,
        limit,
      ).map(commandOf);
    },

    changeCommand(
      actor: string,
      id: string,
      patch: CommandPatch,
      from?: readonly CommandStatus[],
    ): boolean {
      const row = command(actor, id);
      if (row === undefined) return false;
      if (from !== undefined && !from.includes(row.status as CommandStatus)) return false;
      const sets: string[] = [];
      const values: SQLInputValue[] = [];
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sets.push(`${COMMAND_COLUMNS[field as keyof CommandPatch]} = ?`);
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
      if (sets.length > 0) {
        run(
          `UPDATE commands SET ${sets.join(', ')} WHERE actor_id = ? AND task_id = ?`,
          ...values,
          actor,
          id,
        );
      }
      return true;
    },
  };
}
