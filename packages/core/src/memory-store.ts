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
  Input,
  InputId,
  Json,
} from '@acentric/protocol';

import { patched } from './state.ts';
import type { ActorRecord, Change, Turn } from './state.ts';
import { NameTaken, OutOfOrder, StaleEpoch } from './store.ts';
import type { SealedSecret, Store, StoredDeployment } from './store.ts';

type Kept = {
  actor: Actor;
  turn: Turn;
  epoch: number;
  nextSeq: number;
  configurationGiven: Json | null;
  sent: string | null;
  reasoningFrom: number;
};

/** A copy that shares nothing with what it was made from, as what a database gives back does. */
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  readonly #agents = new Map<AgentId, Agent>();
  readonly #deployments = new Map<DeploymentId, StoredDeployment>();
  readonly #secrets = new Map<string, SealedSecret>();
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

  async listAgents(): Promise<Agent[]> {
    return copy([...this.#agents.values()]);
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

  async conversation(
    actor: ActorId,
    part: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<ConversationEntry[]> {
    const after = (this.#entries.get(actor) ?? []).filter((entry) => entry.seq > (part.after ?? 0));
    return copy(part.limit === undefined ? after : after.slice(0, part.limit));
  }

  async unfinished(): Promise<ActorId[]> {
    return [...this.#actors.values()]
      .filter((kept) => kept.turn.phase !== 'idle' || this.#pending(kept.actor.id).length > 0)
      .map((kept) => kept.actor.id);
  }

  async close(): Promise<void> {}
}
