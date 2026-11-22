// What the store does to the database, as plain functions that run to their end at once. They
// are called on the database's own thread (see `worker.ts`), never on the engine's.

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

import type {
  ActorRecord,
  ActorsQuery,
  Change,
  PageOf,
  Paged,
  Redeem,
  SealedSecret,
  NewTask,
  StoredAccount,
  StoredBlob,
  StoredTask,
  TaskEnding,
  StoredDeployment,
  StoredKey,
  StoredLink,
  StoredSession,
  StoredUser,
  Turn,
  UsageFilter,
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
  pending: number;
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
  'commit',
  'addInput',
]);

export function open(path: string, readOnly: boolean, fullFsync = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
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

export function operations(db: DatabaseSync) {
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  const run = (sql: string, ...values: SQLInputValue[]) =>
    Number(statement(sql).run(...values).changes);
  const get = <T>(sql: string, ...values: SQLInputValue[]) =>
    statement(sql).get(...values) as T | undefined;
  const all = <T>(sql: string, ...values: SQLInputValue[]) => statement(sql).all(...values) as T[];

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

  const task = (actor: ActorId, id: string): TaskRow | undefined =>
    get<TaskRow>('SELECT * FROM tasks WHERE actor_id = ? AND id = ?', actor, id);

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

    deleteAgent(id: AgentId): { deployments: DeploymentId[]; actors: ActorId[] } | undefined {
      if (run('DELETE FROM agents WHERE id = ?', id) === 0) return undefined;
      const deployments = all<{ id: DeploymentId }>(
        'DELETE FROM deployments WHERE agent_id = ? RETURNING id',
        id,
      ).map((row) => row.id);
      run('DELETE FROM secrets WHERE agent_id = ?', id);
      run('DELETE FROM messages WHERE actor_id IN (SELECT id FROM actors WHERE agent_id = ?)', id);
      run('DELETE FROM inputs WHERE actor_id IN (SELECT id FROM actors WHERE agent_id = ?)', id);
      run(
        'DELETE FROM actor_blobs WHERE actor_id IN (SELECT id FROM actors WHERE agent_id = ?)',
        id,
      );
      run('DELETE FROM tasks WHERE actor_id IN (SELECT id FROM actors WHERE agent_id = ?)', id);
      const actors = all<{ id: ActorId }>(
        'DELETE FROM actors WHERE agent_id = ? RETURNING id',
        id,
      ).map((row) => row.id);
      return { deployments, actors };
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
      only('account_id = ?', filter.account);
      only('provider = ?', filter.provider);
      only('model = ?', filter.model);
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
    ): { record: ActorRecord; created: boolean } {
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
           last_turn, turn, owed, epoch, next_seq, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 0, 0, 1, ?, ?)`,
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
      if (change.usage !== null) {
        const { usage: used } = change;
        const counted = used.usage;
        run(
          `INSERT INTO usage (at, actor_id, agent_id, version, account_id, provider, model,
             failure, total_input, input, output, reasoning, cache_read, cache_write,
             web_searches, cost, cost_source, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          used.at,
          used.actor,
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

    quietInputs(actor: ActorId): void {
      run('UPDATE inputs SET quiet = 1 WHERE actor_id = ? AND delivered_at IS NULL', actor);
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
  };
}
