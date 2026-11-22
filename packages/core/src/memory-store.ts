// A store in memory. It is the store of tests, and of an engine that is to forget everything
// when it stops. Two engines given the same one are two processes on one database.

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

import { patched } from './state.ts';
import type { ActorRecord, Change, Turn } from './state.ts';
import { EmailTaken, NameTaken, OutOfOrder, StaleEpoch } from './store.ts';
import type {
  ActorsQuery,
  CommandPatch,
  CommandStatus,
  MachinePatch,
  NewCommand,
  StoredCommand,
  StoredMachine,
  StoredSandbox,
  StoredSandboxProvider,
  PageOf,
  Paged,
  Redeem,
  SealedSecret,
  Store,
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
} from './store.ts';

import { reportOf } from './usage.ts';
import type { UsageFilter, UsageRecord } from './usage.ts';

/**
 * A page of what is in `all`, newest first: those whose `key` is below the cursor, `limit` at
 * most. `key` orders them, and is what the cursor of the next page is.
 */
function pageOf<T>(
  all: readonly T[],
  key: (item: T) => string,
  page: PageOf | undefined,
): Paged<T> {
  const limit = page?.limit ?? Number.POSITIVE_INFINITY;
  const cursor = page?.cursor;
  const sorted = all.toSorted((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  const from = cursor === undefined ? sorted : sorted.filter((item) => key(item) < cursor);
  const items = from.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: from.length > items.length && last !== undefined ? key(last) : null,
  };
}

/** A whole number as text that sorts as the number does. */
const ordered = (value: number): string => String(value).padStart(12, '0');

type Kept = {
  actor: Actor;
  turn: Turn;
  epoch: number;
  nextSeq: number;
  configurationGiven: Json | null;
  sent: string | null;
  reasoningFrom: number;
  reasoningSent: Actor['reasoning'] | null;
};

/** A copy that shares nothing with what it was made from, as what a database gives back does. */
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  readonly #agents = new Map<AgentId, Agent>();
  readonly #deployments = new Map<DeploymentId, StoredDeployment>();
  readonly #secrets = new Map<string, SealedSecret>();
  readonly #keys = new Map<KeyId, StoredKey>();
  readonly #users = new Map<UserId, StoredUser>();
  readonly #sessions = new Map<SessionId, StoredSession>();
  readonly #links = new Map<InviteId, StoredLink>();
  readonly #audit: AuditEvent[] = [];
  readonly #accounts = new Map<AccountId, StoredAccount>();
  readonly #usage: UsageRecord[] = [];
  readonly #tasks = new Map<ActorId, StoredTask[]>();
  readonly #blobs = new Map<string, StoredBlob>();
  /** The blobs each actor refers to, each with the media type the actor first gave it. */
  readonly #blobRefs = new Map<ActorId, Map<string, string>>();
  readonly #actors = new Map<ActorId, Kept>();
  /** The variables of actors' commands, sealed. */
  readonly #envs = new Map<ActorId, string>();
  readonly #machines = new Map<MachineId, StoredMachine>();
  readonly #sandboxProviders = new Map<SandboxProviderId, StoredSandboxProvider>();
  /** By `actor/task`. */
  readonly #commands = new Map<string, StoredCommand>();
  readonly #inputs = new Map<ActorId, Input[]>();
  readonly #entries = new Map<ActorId, ConversationEntry[]>();
  /** How many commits were stored, over every actor. */
  commits = 0;

  #pending(actor: ActorId): Input[] {
    return (this.#inputs.get(actor) ?? []).filter((input) => input.deliveredAt === null);
  }

  #record(kept: Kept): ActorRecord {
    const pendingInputs = this.#pending(kept.actor.id).length;
    return copy({ ...kept, actor: { ...kept.actor, pendingInputs } });
  }

  async addDeployment(given: {
    readonly agent: Agent;
    readonly deployment: Deployment;
    readonly code: string;
  }): Promise<void> {
    const { agent, deployment, code } = given;
    const there = this.#agents.get(agent.id);
    const named = [...this.#agents.values()].find((other) => other.name === agent.name);
    if (there === undefined && named !== undefined) throw new NameTaken(agent.name, 'agent');
    if (deployment.version !== (there?.latestDeployment.version ?? 0) + 1) {
      throw new OutOfOrder(agent.id, deployment.version);
    }
    this.#deployments.set(deployment.id, copy({ deployment, code }));
    this.#agents.set(agent.id, copy(agent));
  }

  async setActive(agent: AgentId, version: number): Promise<Agent | undefined> {
    const there = this.#agents.get(agent);
    const deployment = await this.findDeployment(agent, version);
    if (there === undefined || deployment === undefined) return undefined;
    const now = { ...there, activeDeployment: { id: deployment.id, version } };
    this.#agents.set(agent, now);
    return copy(now);
  }

  async loadAgent(id: AgentId): Promise<Agent | undefined> {
    return copy(this.#agents.get(id));
  }

  async findAgent(name: string): Promise<Agent | undefined> {
    return copy([...this.#agents.values()].find((agent) => agent.name === name));
  }

  async listAgents(page?: PageOf): Promise<Paged<Agent>> {
    return copy(pageOf([...this.#agents.values()], (agent) => agent.id, page));
  }

  async listDeployments(agent: AgentId, page?: PageOf): Promise<Paged<Deployment>> {
    const all = [...this.#deployments.values()]
      .map((stored) => stored.deployment)
      .filter((deployment) => deployment.agent === agent);
    return copy(pageOf(all, (deployment) => ordered(deployment.version), page));
  }

  async deleteAgent(
    id: AgentId,
  ): Promise<{ deployments: DeploymentId[]; actors: ActorId[] } | undefined> {
    if (!this.#agents.delete(id)) return undefined;
    const deployments = [...this.#deployments.values()]
      .filter(({ deployment }) => deployment.agent === id)
      .map(({ deployment }) => deployment.id);
    for (const deployment of deployments) this.#deployments.delete(deployment);
    for (const [key, secret] of this.#secrets) if (secret.agent === id) this.#secrets.delete(key);
    const actors = [...this.#actors.values()]
      .filter((kept) => kept.actor.agent === id)
      .map((kept) => kept.actor.id);
    for (const actor of actors) {
      this.#actors.delete(actor);
      this.#inputs.delete(actor);
      this.#entries.delete(actor);
      this.#blobRefs.delete(actor);
      this.#tasks.delete(actor);
      this.#envs.delete(actor);
    }
    for (const [machineId, machine] of this.#machines) {
      if (machine.agents === '*' || !machine.agents.includes(id)) continue;
      const agents = machine.agents.filter((one) => one !== id);
      this.#machines.set(machineId, { ...machine, agents });
    }
    return { deployments, actors };
  }

  async addBlob(actor: ActorId, blob: StoredBlob): Promise<boolean> {
    if (!this.#actors.has(actor)) return false;
    if (!this.#blobs.has(blob.digest)) this.#blobs.set(blob.digest, blob);
    const refs = this.#blobRefs.get(actor) ?? new Map<string, string>();
    if (!refs.has(blob.digest)) refs.set(blob.digest, blob.mediaType);
    this.#blobRefs.set(actor, refs);
    return true;
  }

  async blobOf(actor: ActorId, digest: string): Promise<StoredBlob | undefined> {
    const mediaType = this.#blobRefs.get(actor)?.get(digest);
    const blob = this.#blobs.get(digest);
    return mediaType === undefined || blob === undefined ? undefined : { ...blob, mediaType };
  }

  async dropUnreferencedBlobs(): Promise<string[]> {
    const referred = new Set([...this.#blobRefs.values()].flatMap((refs) => [...refs.keys()]));
    const gone = [...this.#blobs.keys()].filter((digest) => !referred.has(digest));
    for (const digest of gone) this.#blobs.delete(digest);
    return gone;
  }

  async listBlobs(): Promise<string[]> {
    return [...this.#blobs.keys()];
  }

  async setAgentAccount(agent: AgentId, account: AccountId | null): Promise<Agent | undefined> {
    const there = this.#agents.get(agent);
    if (there === undefined) return undefined;
    const now = { ...there, account };
    this.#agents.set(agent, now);
    return copy(now);
  }

  #accountNamed(name: string, but?: AccountId): boolean {
    return [...this.#accounts.values()].some(
      ({ account }) => account.name === name && account.id !== but,
    );
  }

  async addAccount(stored: StoredAccount): Promise<void> {
    if (this.#accountNamed(stored.account.name))
      throw new NameTaken(stored.account.name, 'account');
    this.#accounts.set(stored.account.id, copy(stored));
  }

  async loadAccount(id: AccountId): Promise<StoredAccount | undefined> {
    return copy(this.#accounts.get(id));
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return copy([...this.#accounts.values()]);
  }

  async saveAccount(stored: StoredAccount): Promise<void> {
    const { id, name } = stored.account;
    if (!this.#accounts.has(id)) return;
    if (this.#accountNamed(name, id)) throw new NameTaken(name, 'account');
    this.#accounts.set(id, copy(stored));
  }

  async removeAccount(id: AccountId): Promise<void> {
    this.#accounts.delete(id);
  }

  async agentsOf(account: AccountId): Promise<AgentId[]> {
    return [...this.#agents.values()]
      .filter((agent) => agent.account === account)
      .map((agent) => agent.id);
  }

  async usage(filter: UsageFilter = {}, by?: UsageGroup): Promise<UsageReport> {
    return reportOf(this.#usage, filter, by);
  }

  async addKey(key: StoredKey): Promise<void> {
    this.#keys.set(key.key.id, copy(key));
  }

  async loadKey(id: KeyId): Promise<StoredKey | undefined> {
    return copy(this.#keys.get(id));
  }

  async listKeys(): Promise<StoredKey[]> {
    return copy([...this.#keys.values()]);
  }

  async removeKeys(ids: readonly KeyId[]): Promise<void> {
    for (const id of ids) this.#keys.delete(id);
  }

  async touchKey(id: KeyId, at: number): Promise<void> {
    const kept = this.#keys.get(id);
    if (kept !== undefined) this.#keys.set(id, { ...kept, key: { ...kept.key, lastUsedAt: at } });
  }

  async loadDeployment(id: DeploymentId): Promise<StoredDeployment | undefined> {
    return copy(this.#deployments.get(id));
  }

  async findDeployment(agent: AgentId, version: number): Promise<Deployment | undefined> {
    const found = [...this.#deployments.values()].find(
      ({ deployment }) => deployment.agent === agent && deployment.version === version,
    );
    return copy(found?.deployment);
  }

  async setSecret(secret: SealedSecret): Promise<void> {
    this.#secrets.set(`${secret.agent}\0${secret.name}`, copy(secret));
  }

  async getSecret(agent: AgentId, name: string): Promise<SealedSecret | undefined> {
    return copy(this.#secrets.get(`${agent}\0${name}`));
  }

  async secretNames(agent: AgentId): Promise<string[]> {
    return [...this.#secrets.values()]
      .filter((secret) => secret.agent === agent)
      .map((secret) => secret.name)
      .toSorted();
  }

  async deleteSecret(agent: AgentId, name: string): Promise<boolean> {
    return this.#secrets.delete(`${agent}\0${name}`);
  }

  async allSecrets(): Promise<SealedSecret[]> {
    return copy([...this.#secrets.values()]);
  }

  async addUser(stored: StoredUser): Promise<void> {
    const taken = [...this.#users.values()].some((one) => one.user.email === stored.user.email);
    if (taken) throw new EmailTaken(stored.user.email);
    this.#users.set(stored.user.id, copy(stored));
  }

  async loadUser(id: UserId): Promise<StoredUser | undefined> {
    return copy(this.#users.get(id));
  }

  async findUser(email: string): Promise<StoredUser | undefined> {
    return copy([...this.#users.values()].find((one) => one.user.email === email));
  }

  async listUsers(): Promise<User[]> {
    return copy([...this.#users.values()].map((one) => one.user));
  }

  async saveUser(stored: StoredUser): Promise<void> {
    if (this.#users.has(stored.user.id)) this.#users.set(stored.user.id, copy(stored));
  }

  async removeUser(id: UserId): Promise<void> {
    this.#users.delete(id);
    await this.removeSessions(id);
  }

  async addSession(stored: StoredSession): Promise<void> {
    this.#sessions.set(stored.session.id, copy(stored));
  }

  async loadSession(id: SessionId): Promise<StoredSession | undefined> {
    return copy(this.#sessions.get(id));
  }

  async listSessions(user: UserId): Promise<Session[]> {
    return copy(
      [...this.#sessions.values()]
        .map((one) => one.session)
        .filter((session) => session.user === user),
    );
  }

  async touchSession(id: SessionId, lastUsedAt: number, expiresAt: number): Promise<void> {
    const kept = this.#sessions.get(id);
    if (kept === undefined) return;
    this.#sessions.set(id, { ...kept, session: { ...kept.session, lastUsedAt, expiresAt } });
  }

  async removeSession(id: SessionId): Promise<void> {
    this.#sessions.delete(id);
  }

  async removeSessions(user: UserId, keep?: SessionId): Promise<void> {
    for (const [id, { session }] of this.#sessions) {
      if (session.user === user && id !== keep) this.#sessions.delete(id);
    }
  }

  async addLink(link: StoredLink): Promise<void> {
    this.#links.set(link.id, copy(link));
  }

  async loadLink(id: InviteId): Promise<StoredLink | undefined> {
    return copy(this.#links.get(id));
  }

  async listLinks(kind: StoredLink['kind']): Promise<StoredLink[]> {
    return copy([...this.#links.values()].filter((link) => link.kind === kind));
  }

  async removeLink(id: InviteId): Promise<boolean> {
    return this.#links.delete(id);
  }

  async redeemLink(id: InviteId, redeem: Redeem): Promise<'done' | 'gone'> {
    // In one go, with nothing awaited in between: of two who use a link at once, one does.
    if (!this.#links.has(id)) return 'gone';
    if ('addUser' in redeem) {
      const { user } = redeem.addUser;
      const taken = [...this.#users.values()].some((one) => one.user.email === user.email);
      if (taken) throw new EmailTaken(user.email);
      this.#users.set(user.id, copy(redeem.addUser));
    } else {
      const kept = this.#users.get(redeem.setPassword.user);
      if (kept !== undefined) {
        this.#users.set(kept.user.id, { ...kept, password: redeem.setPassword.password });
      }
    }
    this.#links.delete(id);
    return 'done';
  }

  async addAuditEvent(event: AuditEvent): Promise<void> {
    this.#audit.push(copy(event));
  }

  async listAuditEvents(
    query: PageOf & { readonly action?: string } = { limit: Number.POSITIVE_INFINITY },
  ): Promise<Paged<AuditEvent>> {
    const all = this.#audit.filter(
      (event) => query.action === undefined || event.action === query.action,
    );
    return copy(pageOf(all, (event) => event.id, query));
  }

  async createActor(
    actor: Actor,
    configurationGiven: Json | null = null,
    env: string | null = null,
  ): Promise<{ record: ActorRecord; created: boolean }> {
    const siblings = [...this.#actors.values()].filter((kept) => kept.actor.agent === actor.agent);
    if (actor.externalId !== null) {
      const there = siblings.find((kept) => kept.actor.externalId === actor.externalId);
      if (there !== undefined) return { record: this.#record(there), created: false };
    }
    if (actor.name !== null && siblings.some((kept) => kept.actor.name === actor.name)) {
      throw new NameTaken(actor.name);
    }
    const kept: Kept = {
      actor: copy(actor),
      turn: { phase: 'idle' },
      epoch: 0,
      nextSeq: 1,
      configurationGiven: copy(configurationGiven),
      sent: null,
      reasoningFrom: 1,
      reasoningSent: null,
    };
    this.#actors.set(actor.id, kept);
    if (env !== null) this.#envs.set(actor.id, env);
    return { record: this.#record(kept), created: true };
  }

  async actorEnv(actor: ActorId): Promise<string | null> {
    return this.#envs.get(actor) ?? null;
  }

  async setActorEnv(
    actor: ActorId,
    names: readonly string[],
    sealed: string | null,
  ): Promise<boolean> {
    const kept = this.#actors.get(actor);
    if (kept === undefined || kept.actor.machine === null) return false;
    kept.actor = { ...kept.actor, machine: { ...kept.actor.machine, env: [...names] } };
    if (sealed === null) this.#envs.delete(actor);
    else this.#envs.set(actor, sealed);
    return true;
  }

  async loadActor(id: ActorId): Promise<ActorRecord | undefined> {
    const kept = this.#actors.get(id);
    return kept === undefined ? undefined : this.#record(kept);
  }

  async findActor(agent: AgentId, externalId: string): Promise<ActorRecord | undefined> {
    const found = [...this.#actors.values()].find(
      (kept) => kept.actor.agent === agent && kept.actor.externalId === externalId,
    );
    return found === undefined ? undefined : this.#record(found);
  }

  async listActors(
    query: ActorsQuery = { limit: Number.POSITIVE_INFINITY },
  ): Promise<Paged<Actor>> {
    const all = [...this.#actors.values()]
      .map((kept) => this.#record(kept).actor)
      .filter(
        (actor) =>
          (query.agent === undefined || actor.agent === query.agent) &&
          (query.actor === undefined || actor.id === query.actor) &&
          (query.status === undefined || actor.status === query.status) &&
          (query.name === undefined || actor.name === query.name) &&
          (query.externalId === undefined || actor.externalId === query.externalId),
      );
    return pageOf(all, (actor) => actor.id, query);
  }

  async commit(id: ActorId, epoch: number, change: Change): Promise<void> {
    const kept = this.#actors.get(id);
    if (kept === undefined) throw new Error(`There is no actor ${id}`);
    if (kept.epoch !== epoch) throw new StaleEpoch(id, epoch, kept.epoch);
    const name = change.set?.name;
    if (typeof name === 'string') {
      const taken = [...this.#actors.values()].some(
        (other) =>
          other !== kept && other.actor.agent === kept.actor.agent && other.actor.name === name,
      );
      if (taken) throw new NameTaken(name);
    }

    if (change.set?.configurationGiven !== undefined) {
      kept.configurationGiven = copy(change.set.configurationGiven);
    }
    if (change.set?.reasoningSent !== undefined) kept.reasoningSent = change.set.reasoningSent;
    if (change.usage !== null) this.#usage.push(copy(change.usage));
    if (change.sent !== null) {
      kept.sent = change.sent.fingerprint;
      kept.reasoningFrom = change.sent.reasoningFrom;
    }
    kept.actor = {
      ...patched(kept.actor, copy(change.set)),
      status: change.status,
      lastTurn: copy(change.lastTurn),
      archivedAt: change.archivedAt,
    };
    kept.turn = copy(change.turn);
    kept.epoch += 1;
    kept.nextSeq += change.append.length;
    const entries = [...(this.#entries.get(id) ?? []), ...copy(change.append)];
    const { leaveOutFrom } = change;
    this.#entries.set(
      id,
      leaveOutFrom === null
        ? entries
        : entries.map((entry) => (entry.seq >= leaveOutFrom ? { ...entry, leftOut: true } : entry)),
    );
    for (const input of this.#inputs.get(id) ?? []) {
      if (change.deliver.includes(input.id)) input.deliveredAt = change.at;
    }
    this.commits += 1;
  }

  async addInput(input: Input): Promise<'accepted' | 'duplicate'> {
    const inputs = this.#inputs.get(input.actor) ?? [];
    const known =
      input.externalId !== null && inputs.some((other) => other.externalId === input.externalId);
    if (known) return 'duplicate';
    this.#inputs.set(input.actor, [...inputs, copy(input)]);
    return 'accepted';
  }

  async findInput(actor: ActorId, externalId: string): Promise<InputId | undefined> {
    return (this.#inputs.get(actor) ?? []).find((input) => input.externalId === externalId)?.id;
  }

  async pendingInputs(actor: ActorId): Promise<Input[]> {
    return copy(this.#pending(actor));
  }

  async listInputs(
    actor: ActorId,
    query: PageOf & { readonly pending?: boolean } = { limit: Number.POSITIVE_INFINITY },
  ): Promise<Paged<Input>> {
    const all = (this.#inputs.get(actor) ?? []).filter(
      (input) => query.pending === undefined || (input.deliveredAt === null) === query.pending,
    );
    return copy(pageOf(all, (input) => input.id, query));
  }

  async conversation(
    actor: ActorId,
    part: {
      readonly after?: number;
      readonly before?: number;
      readonly limit?: number;
      readonly order?: 'asc' | 'desc';
    } = {},
  ): Promise<ConversationEntry[]> {
    const within = (this.#entries.get(actor) ?? []).filter(
      (entry) =>
        entry.seq > (part.after ?? 0) && entry.seq < (part.before ?? Number.POSITIVE_INFINITY),
    );
    const inOrder = part.order === 'desc' ? within.toReversed() : within;
    return copy(part.limit === undefined ? inOrder : inOrder.slice(0, part.limit));
  }

  async quietInputs(actor: ActorId): Promise<void> {
    const inputs = this.#inputs.get(actor);
    if (inputs === undefined) return;
    this.#inputs.set(
      actor,
      inputs.map((input) => (input.deliveredAt === null ? { ...input, quiet: true } : input)),
    );
  }

  async unfinished(): Promise<ActorId[]> {
    return [...this.#actors.values()]
      .filter(
        (kept) =>
          kept.turn.phase !== 'idle' ||
          this.#pending(kept.actor.id).some((input) => input.quiet !== true),
      )
      .map((kept) => kept.actor.id);
  }

  async startTask(given: NewTask): Promise<StoredTask> {
    const { prefix, ...task } = given;
    const tasks = this.#tasks.get(task.actor) ?? [];
    const started = tasks.find((other) => other.callId === task.callId);
    if (started !== undefined) return copy(started);
    const count = tasks.filter((other) => other.kind === task.kind).length;
    const stored: StoredTask = {
      ...copy(task),
      id: `${prefix}${String(count + 1)}`,
      status: 'running',
      stoppedBy: null,
      result: null,
      summary: null,
      images: [],
      endedAt: null,
    };
    this.#tasks.set(task.actor, [...tasks, stored]);
    return copy(stored);
  }

  async loadTask(actor: ActorId, id: string): Promise<StoredTask | undefined> {
    const task = (this.#tasks.get(actor) ?? []).find((other) => other.id === id);
    return task === undefined ? undefined : copy(task);
  }

  async taskOfCall(actor: ActorId, callId: string): Promise<StoredTask | undefined> {
    const task = (this.#tasks.get(actor) ?? []).find((other) => other.callId === callId);
    return task === undefined ? undefined : copy(task);
  }

  async listTasks(
    actor: ActorId,
    query: { readonly running?: boolean } = {},
  ): Promise<StoredTask[]> {
    // In the order they were started, they are in the order they were stored.
    const tasks = (this.#tasks.get(actor) ?? []).filter(
      (task) => query.running !== true || task.status === 'running',
    );
    return copy(tasks.toReversed());
  }

  async runningTasks(): Promise<StoredTask[]> {
    return copy([...this.#tasks.values()].flat().filter((task) => task.status === 'running'));
  }

  #changeTask(actor: ActorId, id: string, change: (task: StoredTask) => StoredTask): void {
    const tasks = this.#tasks.get(actor) ?? [];
    this.#tasks.set(
      actor,
      tasks.map((task) => (task.id === id ? change(task) : task)),
    );
  }

  async detachTask(actor: ActorId, id: string): Promise<boolean> {
    const task = (this.#tasks.get(actor) ?? []).find((other) => other.id === id);
    if (task?.status !== 'running' || !task.attached) return false;
    this.#changeTask(actor, id, (one) => ({ ...one, attached: false }));
    return true;
  }

  async detachTasks(actor: ActorId): Promise<StoredTask[]> {
    const waited = (this.#tasks.get(actor) ?? []).filter(
      (task) => task.status === 'running' && task.attached,
    );
    for (const task of waited)
      this.#changeTask(actor, task.id, (one) => ({ ...one, attached: false }));
    return copy(waited.map((task) => ({ ...task, attached: false })));
  }

  async endTask(
    actor: ActorId,
    id: string,
    end: TaskEnding,
    notice: Input | null,
  ): Promise<{ readonly ended: boolean; readonly notified: boolean }> {
    const task = (this.#tasks.get(actor) ?? []).find((other) => other.id === id);
    if (task?.status !== 'running') return { ended: false, notified: false };
    this.#changeTask(actor, id, (one) => ({ ...one, ...copy(end) }));
    // A task its call still waits for is told by that call's result, and by nothing else.
    if (notice === null || task.attached || !this.#actors.has(actor)) {
      return { ended: true, notified: false };
    }
    this.#inputs.set(actor, [...(this.#inputs.get(actor) ?? []), copy(notice)]);
    return { ended: true, notified: true };
  }

  async addMachine(machine: StoredMachine): Promise<void> {
    if (this.#machineNamed(machine.name)) throw new NameTaken(machine.name, 'machine');
    this.#machines.set(machine.id, copy(machine));
  }

  #machineNamed(name: string, but?: MachineId): boolean {
    return [...this.#machines.values()].some((one) => one.name === name && one.id !== but);
  }

  async loadMachine(id: MachineId): Promise<StoredMachine | undefined> {
    return copy(this.#machines.get(id));
  }

  async findMachine(name: string): Promise<StoredMachine | undefined> {
    return copy([...this.#machines.values()].find((one) => one.name === name));
  }

  async listMachines(): Promise<StoredMachine[]> {
    return copy([...this.#machines.values()]);
  }

  async changeMachine(id: MachineId, patch: MachinePatch): Promise<StoredMachine | undefined> {
    const machine = this.#machines.get(id);
    if (machine === undefined) return undefined;
    if (patch.name !== undefined && this.#machineNamed(patch.name, id)) {
      throw new NameTaken(patch.name, 'machine');
    }
    const changed = { ...machine, ...copy(patch) };
    this.#machines.set(id, changed);
    return copy(changed);
  }

  async enrolMachine(
    id: MachineId,
    tokenHash: string,
    publicKey: string,
    at: number,
  ): Promise<boolean> {
    const machine = this.#machines.get(id);
    if (
      machine === undefined ||
      machine.tokenHash !== tokenHash ||
      machine.tokenExpiresAt === null ||
      machine.tokenExpiresAt <= at
    ) {
      return false;
    }
    this.#machines.set(id, {
      ...machine,
      publicKey,
      tokenHash: null,
      tokenExpiresAt: null,
      enrolledAt: at,
    });
    return true;
  }

  async removeMachine(
    id: MachineId,
    lost: { readonly error: string; readonly endedAt: number },
  ): Promise<StoredCommand[] | undefined> {
    if (!this.#machines.delete(id)) return undefined;
    const open = await this.openCommands(id);
    for (const command of open) {
      this.#commands.set(`${command.actor}/${command.task}`, {
        ...command,
        status: 'lost',
        ...lost,
      });
    }
    return open;
  }

  async addSandboxProvider(provider: StoredSandboxProvider): Promise<void> {
    if ([...this.#sandboxProviders.values()].some((one) => one.name === provider.name)) {
      throw new NameTaken(provider.name, 'provider account');
    }
    this.#sandboxProviders.set(provider.id, copy(provider));
  }

  async loadSandboxProvider(id: SandboxProviderId): Promise<StoredSandboxProvider | undefined> {
    return copy(this.#sandboxProviders.get(id));
  }

  async listSandboxProviders(): Promise<StoredSandboxProvider[]> {
    return copy([...this.#sandboxProviders.values()]);
  }

  async removeSandboxProvider(id: SandboxProviderId): Promise<'removed' | 'in_use' | 'missing'> {
    if (!this.#sandboxProviders.has(id)) return 'missing';
    if ([...this.#machines.values()].some((one) => one.sandbox?.provider === id)) return 'in_use';
    this.#sandboxProviders.delete(id);
    return 'removed';
  }

  async setSandbox(id: MachineId, sandbox: StoredSandbox): Promise<boolean> {
    const machine = this.#machines.get(id);
    if (machine === undefined || !this.#sandboxProviders.has(sandbox.provider)) return false;
    this.#machines.set(id, { ...machine, sandbox: copy(sandbox) });
    return true;
  }

  async addCommand(command: NewCommand): Promise<{ command: StoredCommand; created: boolean }> {
    const key = `${command.actor}/${command.task}`;
    const there = this.#commands.get(key);
    if (there !== undefined) return { command: copy(there), created: false };
    const stored: StoredCommand = {
      ...copy(command),
      status: 'starting',
      stopWanted: false,
      exit: null,
      stoppedBy: null,
      ranMs: null,
      bytes: null,
      lines: null,
      tail: null,
      log: null,
      error: null,
      endedAt: null,
    };
    this.#commands.set(key, stored);
    return { command: copy(stored), created: true };
  }

  async addOwnCommand(command: Omit<NewCommand, 'task'>): Promise<StoredCommand> {
    const own = [...this.#commands.values()].filter((one) => one.actor === command.actor);
    const added = await this.addCommand({ ...command, task: `c${String(own.length + 1)}` });
    return added.command;
  }

  async loadCommand(actor: string, task: string): Promise<StoredCommand | undefined> {
    return copy(this.#commands.get(`${actor}/${task}`));
  }

  async openCommands(machine: MachineId): Promise<StoredCommand[]> {
    return copy(
      [...this.#commands.values()].filter(
        (one) => one.machine === machine && (one.status === 'starting' || one.status === 'running'),
      ),
    );
  }

  async listCommands(actor: string, machine: MachineId, limit: number): Promise<StoredCommand[]> {
    return copy(
      [...this.#commands.values()]
        .filter((one) => one.actor === actor && one.machine === machine)
        .toReversed()
        .slice(0, limit),
    );
  }

  async changeCommand(
    actor: string,
    task: string,
    patch: CommandPatch,
    from?: readonly CommandStatus[],
  ): Promise<boolean> {
    const key = `${actor}/${task}`;
    const command = this.#commands.get(key);
    if (command === undefined || (from !== undefined && !from.includes(command.status))) {
      return false;
    }
    this.#commands.set(key, { ...command, ...copy(patch) });
    return true;
  }

  async close(): Promise<void> {}
}
