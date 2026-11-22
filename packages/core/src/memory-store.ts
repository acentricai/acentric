// A store in memory. It is the store of tests, and of an engine that is to forget everything
// when it stops. Two engines given the same one are two processes on one database.

import type {
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
  Session,
  SessionId,
  User,
  UserId,
} from '@acentric/protocol';

import { patched } from './state.ts';
import type { ActorRecord, Change, Turn } from './state.ts';
import { EmailTaken, NameTaken, OutOfOrder, StaleEpoch } from './store.ts';
import type {
  ActorsQuery,
  PageOf,
  Paged,
  Redeem,
  SealedSecret,
  Store,
  StoredDeployment,
  StoredKey,
  StoredLink,
  StoredSession,
  StoredUser,
} from './store.ts';

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
  readonly #actors = new Map<ActorId, Kept>();
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
    }
    return { deployments, actors };
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
    return { record: this.#record(kept), created: true };
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

  async unfinished(): Promise<ActorId[]> {
    return [...this.#actors.values()]
      .filter((kept) => kept.turn.phase !== 'idle' || this.#pending(kept.actor.id).length > 0)
      .map((kept) => kept.actor.id);
  }

  async close(): Promise<void> {}
}
