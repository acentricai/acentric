// The store on SQLite: one file, and the engine's only truth.
//
// The database is on threads of its own, so the engine never waits for the disk: one thread
// writes, and one only reads, so that a list or a long conversation does not wait behind a
// write. What the engine asks is sent to a thread, and the answer comes back as a promise.

import { Worker } from 'node:worker_threads';

import { EmailTaken, NameTaken, OutOfOrder, StaleEpoch } from '@acentric/core';
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
  Store,
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
  UsageFilter,
  UsageRecord,
  StoredPhoto,
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
  KeyId,
  MachineId,
  SandboxProviderId,
  Session,
  SessionId,
  UsageGroup,
  UsageReport,
  User,
  UserId,
} from '@acentric/protocol';

import type { Operation } from './database.ts';
import type { Reply, Request, Settings } from './worker.ts';

export type SqliteOptions = {
  /**
   * Whether writes that come together share one transaction, and so one wait for the disk.
   * True without it. False is for measuring what that saves.
   */
  readonly groupCommit?: boolean;
  /**
   * On macOS, whether a commit waits for the disk itself, not only for the system: without it a
   * commit survives the process and the system ending, and may not survive the power going. It
   * is slow, and off without this. On Linux a commit always waits for the disk, and this
   * changes nothing.
   */
  readonly fullFsync?: boolean;
};

// The thread's file is beside this one: TypeScript where this is run as it was written, and
// JavaScript where it was built.
const THREAD = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url,
);

/** One thread, and what is waiting for it to answer. */
class Line {
  readonly #worker: Worker;
  readonly #waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 1;
  #broken: Error | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on('message', (replies: readonly Reply[]) => {
      for (const reply of replies) this.#settle(reply);
    });
    worker.on('error', (error) => {
      this.#fail(error);
    });
    worker.on('exit', () => {
      this.#fail(new Error('The store was closed'));
    });
  }

  static start(settings: Settings): Promise<Line> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(THREAD, { workerData: settings });
      worker.once('error', reject);
      worker.once('message', () => {
        worker.off('error', reject);
        resolve(new Line(worker));
      });
    });
  }

  ask<T>(op: Request['op'], ...args: unknown[]): Promise<T> {
    if (this.#broken !== undefined) return Promise.reject(this.#broken);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#worker.postMessage({ id, op, args } satisfies Request);
    });
  }

  async close(): Promise<void> {
    if (this.#broken !== undefined) return;
    await this.ask('close');
    await this.#worker.terminate();
  }

  #settle(reply: Reply): void {
    const waiting = this.#waiting.get(reply.id);
    if (waiting === undefined) return;
    this.#waiting.delete(reply.id);
    if (reply.ok) {
      waiting.resolve(reply.value);
      return;
    }
    const { refused } = reply;
    if (refused?.kind === 'StaleEpoch') {
      const [actor, read, now] = refused.args as [ActorId, number, number];
      waiting.reject(new StaleEpoch(actor, read, now));
    } else if (refused?.kind === 'NameTaken') {
      const said = refused.args[1];
      const of =
        said === 'agent' ||
        said === 'account' ||
        said === 'machine' ||
        said === 'provider account' ||
        said === 'subagent'
          ? said
          : 'actor';
      waiting.reject(new NameTaken(String(refused.args[0]), of));
    } else if (refused?.kind === 'EmailTaken') {
      waiting.reject(new EmailTaken(String(refused.args[0])));
    } else if (refused?.kind === 'OutOfOrder') {
      const [agent, version] = refused.args as [AgentId, number];
      waiting.reject(new OutOfOrder(agent, version));
    } else {
      waiting.reject(new Error(reply.message));
    }
  }

  #fail(error: Error): void {
    this.#broken ??= error;
    for (const waiting of this.#waiting.values()) waiting.reject(this.#broken);
    this.#waiting.clear();
  }
}

export class SqliteStore implements Store {
  readonly #write: Line;
  readonly #read: Line;

  private constructor(write: Line, read: Line) {
    this.#write = write;
    this.#read = read;
  }

  /** Opens the database at `path`, making it and bringing its tables up to date as needed. */
  static async open(path: string, options: SqliteOptions = {}): Promise<SqliteStore> {
    const groupCommit = options.groupCommit ?? true;
    const fullFsync = options.fullFsync ?? false;
    const write = await Line.start({ path, readOnly: false, groupCommit, fullFsync });
    // A database in memory is one connection's own: there is nothing for a second to read.
    const read =
      path === ':memory:'
        ? write
        : await Line.start({ path, readOnly: true, groupCommit, fullFsync });
    return new SqliteStore(write, read);
  }

  addDeployment(given: {
    readonly agent: Agent;
    readonly deployment: Deployment;
    readonly code: string;
  }): Promise<void> {
    return this.#write.ask('addDeployment' satisfies Operation, given);
  }

  setActive(agent: AgentId, version: number): Promise<Agent | undefined> {
    return this.#write.ask('setActive' satisfies Operation, agent, version);
  }

  // What the engine acts on is read where it was written, so that it is never behind.
  loadAgent(id: AgentId): Promise<Agent | undefined> {
    return this.#write.ask('loadAgent' satisfies Operation, id);
  }

  findAgent(name: string): Promise<Agent | undefined> {
    return this.#write.ask('findAgent' satisfies Operation, name);
  }

  listAgents(page?: PageOf): Promise<Paged<Agent>> {
    return this.#read.ask('listAgents' satisfies Operation, page);
  }

  listDeployments(agent: AgentId, page?: PageOf): Promise<Paged<Deployment>> {
    return this.#read.ask('listDeployments' satisfies Operation, agent, page);
  }

  deleteAgent(
    id: AgentId,
  ): Promise<{ deployments: DeploymentId[]; actors: ActorId[] } | undefined> {
    return this.#write.ask('deleteAgent' satisfies Operation, id);
  }

  agentTree(id: AgentId): Promise<ActorId[]> {
    return this.#write.ask('agentTree' satisfies Operation, id);
  }

  deleteActor(id: ActorId): Promise<ActorId[] | undefined> {
    return this.#write.ask('deleteActor' satisfies Operation, id);
  }

  /** Gives the pages nothing is in back to the disk, and says how many bytes went. */
  freePages(): Promise<number> {
    return this.#write.ask('freePages' satisfies Operation);
  }

  archivedBefore(before: number, limit: number): Promise<ActorId[]> {
    return this.#read.ask('archivedBefore' satisfies Operation, before, limit);
  }

  removeExpired(now: number): Promise<{ sessions: number; links: number }> {
    return this.#write.ask('removeExpired' satisfies Operation, now);
  }

  pruneAudit(before: number, limit: number): Promise<number> {
    return this.#write.ask('pruneAudit' satisfies Operation, before, limit);
  }

  pruneUsage(before: number, limit: number): Promise<number> {
    return this.#write.ask('pruneUsage' satisfies Operation, before, limit);
  }

  setAgentAccount(agent: AgentId, account: AccountId | null): Promise<Agent | undefined> {
    return this.#write.ask('setAgentAccount' satisfies Operation, agent, account);
  }

  addAccount(account: StoredAccount): Promise<void> {
    return this.#write.ask('addAccount' satisfies Operation, account);
  }

  // What a model is called with is read where it was written, so that it is never behind.
  loadAccount(id: AccountId): Promise<StoredAccount | undefined> {
    return this.#write.ask('loadAccount' satisfies Operation, id);
  }

  listAccounts(): Promise<StoredAccount[]> {
    return this.#write.ask('listAccounts' satisfies Operation);
  }

  saveAccount(account: StoredAccount): Promise<void> {
    return this.#write.ask('saveAccount' satisfies Operation, account);
  }

  removeAccount(id: AccountId): Promise<void> {
    return this.#write.ask('removeAccount' satisfies Operation, id);
  }

  agentsOf(account: AccountId): Promise<AgentId[]> {
    return this.#write.ask('agentsOf' satisfies Operation, account);
  }

  quietInputs(actor: ActorId, only?: readonly string[]): Promise<void> {
    return this.#write.ask('quietInputs' satisfies Operation, actor, only);
  }

  startTask(task: NewTask): Promise<StoredTask> {
    return this.#write.ask('startTask' satisfies Operation, task);
  }

  // Tasks are read where they are written: a task that was just stored, let go of or ended is
  // so at once for whoever asks next.
  loadTask(actor: ActorId, id: string): Promise<StoredTask | undefined> {
    return this.#write.ask('loadTask' satisfies Operation, actor, id);
  }

  taskOfCall(actor: ActorId, callId: string): Promise<StoredTask | undefined> {
    return this.#write.ask('taskOfCall' satisfies Operation, actor, callId);
  }

  listTasks(actor: ActorId, query?: { readonly running?: boolean }): Promise<StoredTask[]> {
    return this.#write.ask('listTasks' satisfies Operation, actor, query);
  }

  runningTasks(): Promise<StoredTask[]> {
    return this.#write.ask('runningTasks' satisfies Operation);
  }

  detachTask(actor: ActorId, id: string): Promise<boolean> {
    return this.#write.ask('detachTask' satisfies Operation, actor, id);
  }

  detachTasks(actor: ActorId): Promise<StoredTask[]> {
    return this.#write.ask('detachTasks' satisfies Operation, actor);
  }

  endTask(
    actor: ActorId,
    id: string,
    end: TaskEnding,
    notice: Input | null,
  ): Promise<{ readonly ended: boolean; readonly notified: boolean }> {
    return this.#write.ask('endTask' satisfies Operation, actor, id, end, notice);
  }

  // A script's journal is read where it is written, as its task is.
  startScript(
    actor: ActorId,
    task: string,
    script: Pick<StoredScript, 'startedAt' | 'seed' | 'catalog'>,
  ): Promise<StoredScript> {
    return this.#write.ask('startScript' satisfies Operation, actor, task, script);
  }

  loadScript(actor: ActorId, task: string): Promise<StoredScript | undefined> {
    return this.#write.ask('loadScript' satisfies Operation, actor, task);
  }

  endScript(actor: ActorId, task: string, kept: ScriptKept): Promise<void> {
    return this.#write.ask('endScript' satisfies Operation, actor, task, kept);
  }

  listScriptCalls(actor: ActorId, task: string): Promise<ScriptCall[]> {
    return this.#write.ask('listScriptCalls' satisfies Operation, actor, task);
  }

  addScriptCall(actor: ActorId, task: string, call: Omit<ScriptCall, 'done'>): Promise<void> {
    return this.#write.ask('addScriptCall' satisfies Operation, actor, task, call);
  }

  finishScriptCall(
    actor: ActorId,
    task: string,
    id: number,
    done: NonNullable<ScriptCall['done']>,
  ): Promise<void> {
    return this.#write.ask('finishScriptCall' satisfies Operation, actor, task, id, done);
  }

  // Machines and their commands are read where they are written: what a daemon's connection is
  // settled against is never behind what was just stored.
  addMachine(machine: StoredMachine): Promise<void> {
    return this.#write.ask('addMachine' satisfies Operation, machine);
  }

  loadMachine(id: MachineId): Promise<StoredMachine | undefined> {
    return this.#write.ask('loadMachine' satisfies Operation, id);
  }

  findMachine(name: string): Promise<StoredMachine | undefined> {
    return this.#write.ask('findMachine' satisfies Operation, name);
  }

  listMachines(): Promise<StoredMachine[]> {
    return this.#write.ask('listMachines' satisfies Operation);
  }

  machinesOfActors(query: {
    readonly agents: readonly AgentId[];
    readonly actors: readonly ActorId[];
  }): Promise<MachineId[]> {
    return this.#read.ask('machinesOfActors' satisfies Operation, query);
  }

  changeMachine(id: MachineId, patch: MachinePatch): Promise<StoredMachine | undefined> {
    return this.#write.ask('changeMachine' satisfies Operation, id, patch);
  }

  enrolMachine(id: MachineId, tokenHash: string, publicKey: string, at: number): Promise<boolean> {
    return this.#write.ask('enrolMachine' satisfies Operation, id, tokenHash, publicKey, at);
  }

  removeMachine(
    id: MachineId,
    lost: { readonly error: string; readonly endedAt: number },
  ): Promise<StoredCommand[] | undefined> {
    return this.#write.ask('removeMachine' satisfies Operation, id, lost);
  }

  addCommand(
    command: NewCommand,
  ): Promise<{ readonly command: StoredCommand; readonly created: boolean }> {
    return this.#write.ask('addCommand' satisfies Operation, command);
  }

  addOwnCommand(command: Omit<NewCommand, 'task'>): Promise<StoredCommand> {
    return this.#write.ask('addOwnCommand' satisfies Operation, command);
  }

  loadCommand(actor: string, task: string): Promise<StoredCommand | undefined> {
    return this.#write.ask('loadCommand' satisfies Operation, actor, task);
  }

  findChild(
    parent: ActorId,
    name: string,
  ): Promise<{ readonly actor: Actor; readonly spawnedBy: string | null } | undefined> {
    return this.#write.ask('findChild' satisfies Operation, parent, name);
  }

  listChildren(parent: ActorId): Promise<Actor[]> {
    return this.#write.ask('listChildren' satisfies Operation, parent);
  }

  setStopping(actor: ActorId, stopping: Stopping | null): Promise<void> {
    return this.#write.ask('setStopping' satisfies Operation, actor, stopping);
  }

  listStopping(): Promise<({ readonly actor: ActorId } & Stopping)[]> {
    return this.#write.ask('listStopping' satisfies Operation);
  }

  loadBackupSettings(): Promise<StoredBackupSettings | undefined> {
    return this.#write.ask('loadBackupSettings' satisfies Operation);
  }

  saveBackupSettings(settings: StoredBackupSettings): Promise<void> {
    return this.#write.ask('saveBackupSettings' satisfies Operation, settings);
  }

  addSandboxProvider(provider: StoredSandboxProvider): Promise<void> {
    return this.#write.ask('addSandboxProvider' satisfies Operation, provider);
  }

  loadSandboxProvider(id: SandboxProviderId): Promise<StoredSandboxProvider | undefined> {
    return this.#write.ask('loadSandboxProvider' satisfies Operation, id);
  }

  listSandboxProviders(): Promise<StoredSandboxProvider[]> {
    return this.#write.ask('listSandboxProviders' satisfies Operation);
  }

  removeSandboxProvider(id: SandboxProviderId): Promise<'removed' | 'in_use' | 'missing'> {
    return this.#write.ask('removeSandboxProvider' satisfies Operation, id);
  }

  setSandbox(id: MachineId, sandbox: StoredSandbox): Promise<boolean> {
    return this.#write.ask('setSandbox' satisfies Operation, id, sandbox);
  }

  openCommands(machine: MachineId): Promise<StoredCommand[]> {
    return this.#write.ask('openCommands' satisfies Operation, machine);
  }

  listCommands(actor: string, machine: MachineId, limit: number): Promise<StoredCommand[]> {
    return this.#write.ask('listCommands' satisfies Operation, actor, machine, limit);
  }

  changeCommand(
    actor: string,
    task: string,
    patch: CommandPatch,
    from?: readonly CommandStatus[],
  ): Promise<boolean> {
    return this.#write.ask('changeCommand' satisfies Operation, actor, task, patch, from);
  }

  addBlob(actor: ActorId, blob: StoredBlob): Promise<boolean> {
    return this.#write.ask('addBlob' satisfies Operation, actor, blob);
  }

  // Where it was written: a blob that was just kept is one its actor refers to at once.
  blobOf(actor: ActorId, digest: string): Promise<StoredBlob | undefined> {
    return this.#write.ask('blobOf' satisfies Operation, actor, digest);
  }

  dropUnreferencedBlobs(): Promise<string[]> {
    return this.#write.ask('dropUnreferencedBlobs' satisfies Operation);
  }

  listBlobs(): Promise<string[]> {
    return this.#write.ask('listBlobs' satisfies Operation);
  }

  usage(filter?: UsageFilter, by?: UsageGroup): Promise<UsageReport> {
    return this.#read.ask('usage' satisfies Operation, filter, by);
  }

  recordUsage(record: UsageRecord): Promise<void> {
    return this.#write.ask('recordUsage' satisfies Operation, record);
  }

  // What a model is sent is read where it was written, so that it is never behind.
  latestCompaction(actor: ActorId): Promise<StoredCompaction | undefined> {
    return this.#write.ask('latestCompaction' satisfies Operation, actor);
  }

  listCompactions(actor: ActorId): Promise<StoredCompaction[]> {
    return this.#write.ask('listCompactions' satisfies Operation, actor);
  }

  addKey(key: StoredKey): Promise<void> {
    return this.#write.ask('addKey' satisfies Operation, key);
  }

  // A key is read at every request it comes with: where it was written, so that one just
  // made, or just revoked, is so at once.
  // Who a request is from is read where nothing waits for the disk: every request is, and the
  // reader sees each write once it is stored, which is before it is answered.
  loadKey(id: KeyId): Promise<StoredKey | undefined> {
    return this.#read.ask('loadKey' satisfies Operation, id);
  }

  listKeys(): Promise<StoredKey[]> {
    return this.#write.ask('listKeys' satisfies Operation);
  }

  removeKeys(ids: readonly KeyId[]): Promise<void> {
    return this.#write.ask('removeKeys' satisfies Operation, ids);
  }

  touchKey(id: KeyId, at: number): Promise<void> {
    return this.#write.ask('touchKey' satisfies Operation, id, at);
  }

  loadDeployment(id: DeploymentId): Promise<StoredDeployment | undefined> {
    return this.#write.ask('loadDeployment' satisfies Operation, id);
  }

  findDeployment(agent: AgentId, version: number): Promise<Deployment | undefined> {
    return this.#write.ask('findDeployment' satisfies Operation, agent, version);
  }

  setSecret(secret: SealedSecret): Promise<void> {
    return this.#write.ask('setSecret' satisfies Operation, secret);
  }

  getSecret(agent: AgentId, name: string): Promise<SealedSecret | undefined> {
    return this.#write.ask('getSecret' satisfies Operation, agent, name);
  }

  secretNames(agent: AgentId): Promise<string[]> {
    return this.#write.ask('secretNames' satisfies Operation, agent);
  }

  deleteSecret(agent: AgentId, name: string): Promise<boolean> {
    return this.#write.ask('deleteSecret' satisfies Operation, agent, name);
  }

  allSecrets(): Promise<SealedSecret[]> {
    return this.#write.ask('allSecrets' satisfies Operation);
  }

  addUser(user: StoredUser): Promise<void> {
    return this.#write.ask('addUser' satisfies Operation, user);
  }

  // Who a request is from is read where it was written, so that it is never behind.
  loadUser(id: UserId): Promise<StoredUser | undefined> {
    return this.#read.ask('loadUser' satisfies Operation, id);
  }

  findUser(email: string): Promise<StoredUser | undefined> {
    return this.#read.ask('findUser' satisfies Operation, email);
  }

  listUsers(): Promise<User[]> {
    return this.#write.ask('listUsers' satisfies Operation);
  }

  saveUser(user: StoredUser): Promise<void> {
    return this.#write.ask('saveUser' satisfies Operation, user);
  }

  removeUser(id: UserId): Promise<void> {
    return this.#write.ask('removeUser' satisfies Operation, id);
  }

  setPhoto(id: UserId, photo: StoredPhoto | null): Promise<StoredUser | undefined> {
    return this.#write.ask('setPhoto' satisfies Operation, id, photo);
  }

  loadPhoto(id: UserId): Promise<StoredPhoto | undefined> {
    return this.#read.ask('loadPhoto' satisfies Operation, id);
  }

  addSession(session: StoredSession): Promise<void> {
    return this.#write.ask('addSession' satisfies Operation, session);
  }

  loadSession(id: SessionId): Promise<StoredSession | undefined> {
    return this.#read.ask('loadSession' satisfies Operation, id);
  }

  listSessions(user: UserId): Promise<Session[]> {
    return this.#write.ask('listSessions' satisfies Operation, user);
  }

  touchSession(id: SessionId, lastUsedAt: number, expiresAt: number): Promise<void> {
    return this.#write.ask('touchSession' satisfies Operation, id, lastUsedAt, expiresAt);
  }

  removeSession(id: SessionId): Promise<void> {
    return this.#write.ask('removeSession' satisfies Operation, id);
  }

  removeSessions(user: UserId, keep?: SessionId): Promise<void> {
    return this.#write.ask('removeSessions' satisfies Operation, user, keep);
  }

  addLink(link: StoredLink): Promise<void> {
    return this.#write.ask('addLink' satisfies Operation, link);
  }

  loadLink(id: InviteId): Promise<StoredLink | undefined> {
    return this.#write.ask('loadLink' satisfies Operation, id);
  }

  listLinks(kind: StoredLink['kind']): Promise<StoredLink[]> {
    return this.#write.ask('listLinks' satisfies Operation, kind);
  }

  removeLink(id: InviteId): Promise<boolean> {
    return this.#write.ask('removeLink' satisfies Operation, id);
  }

  redeemLink(id: InviteId, redeem: Redeem): Promise<'done' | 'gone'> {
    return this.#write.ask('redeemLink' satisfies Operation, id, redeem);
  }

  addAuditEvent(event: AuditEvent): Promise<void> {
    return this.#write.ask('addAuditEvent' satisfies Operation, event);
  }

  listAuditEvents(query?: PageOf & { readonly action?: string }): Promise<Paged<AuditEvent>> {
    return this.#read.ask('listAuditEvents' satisfies Operation, query);
  }

  createActor(
    actor: Actor,
    configurationGiven: Json | null = null,
    env: string | null = null,
    spawnedBy: string | null = null,
  ): Promise<{ readonly record: ActorRecord; readonly created: boolean }> {
    return this.#write.ask(
      'createActor' satisfies Operation,
      actor,
      configurationGiven,
      env,
      spawnedBy,
    );
  }

  // Read where they are written: a command is sent with what was just kept.
  actorEnv(actor: ActorId): Promise<string | null> {
    return this.#write.ask('actorEnv' satisfies Operation, actor);
  }

  setActorEnv(actor: ActorId, names: readonly string[], sealed: string | null): Promise<boolean> {
    return this.#write.ask('setActorEnv' satisfies Operation, actor, names, sealed);
  }

  findActor(agent: AgentId, externalId: string): Promise<ActorRecord | undefined> {
    return this.#write.ask('findActor' satisfies Operation, agent, externalId);
  }

  listActors(query?: ActorsQuery): Promise<Paged<Actor>> {
    return this.#read.ask('listActors' satisfies Operation, query);
  }

  // What a driver is made from is read where it was written, so that it is never behind.
  loadActor(id: ActorId): Promise<ActorRecord | undefined> {
    return this.#write.ask('loadActor' satisfies Operation, id);
  }

  commit(id: ActorId, epoch: number, change: Change): Promise<void> {
    return this.#write.ask('commit' satisfies Operation, id, epoch, change);
  }

  addInput(input: Input): Promise<'accepted' | 'duplicate'> {
    return this.#write.ask('addInput' satisfies Operation, input);
  }

  findInput(actor: ActorId, externalId: string): Promise<InputId | undefined> {
    return this.#write.ask('findInput' satisfies Operation, actor, externalId);
  }

  pendingInputs(actor: ActorId): Promise<Input[]> {
    return this.#write.ask('pendingInputs' satisfies Operation, actor);
  }

  listInputs(
    actor: ActorId,
    query?: PageOf & { readonly pending?: boolean },
  ): Promise<Paged<Input>> {
    return this.#read.ask('listInputs' satisfies Operation, actor, query);
  }

  conversation(
    actor: ActorId,
    part?: {
      readonly after?: number;
      readonly before?: number;
      readonly limit?: number;
      readonly order?: 'asc' | 'desc';
    },
  ): Promise<ConversationEntry[]> {
    return this.#read.ask('conversation' satisfies Operation, actor, part);
  }

  unfinished(): Promise<ActorId[]> {
    return this.#write.ask('unfinished' satisfies Operation);
  }

  /** How many writes were stored, and in how many transactions: fewer, when they came together. */
  stats(): Promise<{ readonly writes: number; readonly transactions: number }> {
    return this.#write.ask('stats');
  }

  async close(): Promise<void> {
    if (this.#read !== this.#write) await this.#read.close();
    await this.#write.close();
  }
}
