// What the engine keeps things in. A store keeps agents and their deployments, actors with
// their conversations and their mailboxes, and agents' secrets, and says which actors have
// something owed.
//
// Two rules are the store's to keep, whatever it is made of:
//
//   - A commit is stored whole, or not at all.
//   - A commit names the epoch of the actor it read, and is refused when the actor has been
//     written since. So of two writers that each think the actor theirs, one is stopped.

import type {
  Actor,
  ActorId,
  Agent,
  AgentId,
  ConversationEntry,
  Deployment,
  DeploymentId,
  ErrorCode,
  Input,
  InputId,
  Json,
  Key,
  KeyId,
} from '@acentric/protocol';

import type { ActorRecord, Change } from './state.ts';

/** A commit named an epoch that has passed: something else has written to the actor since. */
export class StaleEpoch extends Error {
  override readonly name = 'StaleEpoch';
  constructor(actor: ActorId, read: number, now: number) {
    super(`${actor} was read at epoch ${String(read)} and is at ${String(now)}`);
  }
}

/** The name is another's: another actor's of the same agent, or another agent's. */
export class NameTaken extends Error {
  override readonly name = 'NameTaken';
  readonly code: ErrorCode = 'name_taken';
  constructor(name: string, of: 'actor' | 'agent' = 'actor') {
    super(
      of === 'actor'
        ? `An actor of this agent is named ${name} already`
        : `An agent is named ${name} already`,
    );
  }
}

/** A deployment was to be kept that does not follow its agent's newest: another got there first. */
export class OutOfOrder extends Error {
  override readonly name = 'OutOfOrder';
  constructor(agent: AgentId, version: number) {
    super(`Version ${String(version)} of ${agent} does not follow its newest`);
  }
}

/** A page of a list: its items, and what names the next page, or null on the last. */
export type Paged<T> = { readonly items: T[]; readonly nextCursor: string | null };

/** Which page of a list is asked for: so many, after where the page before ended. */
export type PageOf = { readonly limit: number; readonly cursor?: string };

/** An API key as the store keeps it: never the key itself, only what tells it is the one. */
export type StoredKey = {
  readonly key: Key;
  /** The SHA-256 of the key's secret part, in hex. */
  readonly hash: string;
  /** The key that made it: it is revoked with that one. Null for one no key made. */
  readonly parent: KeyId | null;
};

/** Which actors a list gives. Each filter narrows it. */
export type ActorsQuery = PageOf & {
  readonly agent?: AgentId;
  readonly actor?: ActorId;
  readonly status?: Actor['status'];
  readonly name?: string;
  readonly externalId?: string;
};

/** A deployment with the code it runs. */
export type StoredDeployment = { readonly deployment: Deployment; readonly code: string };

/** A secret of an agent's, sealed: the store never has its value. */
export type SealedSecret = {
  readonly agent: AgentId;
  readonly name: string;
  readonly sealed: string;
  readonly updatedAt: number;
};

export interface Store {
  // Agents and deployments

  /**
   * Keeps a deployment and its code, and its agent as it is from then on: the agent itself is
   * kept when this is its first deployment. All of it is kept, or none. Rejects with
   * `NameTaken` when a new agent's name is another's, and with `OutOfOrder` when the
   * deployment's version is not one more than the agent's newest.
   */
  addDeployment(given: {
    readonly agent: Agent;
    readonly deployment: Deployment;
    readonly code: string;
  }): Promise<void>;
  /**
   * Makes the deployment of this version the agent's active one, and gives the agent as it
   * then is. Undefined when there is no such agent, or it has no such version.
   */
  setActive(agent: AgentId, version: number): Promise<Agent | undefined>;
  loadAgent(id: AgentId): Promise<Agent | undefined>;
  findAgent(name: string): Promise<Agent | undefined>;
  /** Agents, newest first. */
  listAgents(page?: PageOf): Promise<Paged<Agent>>;
  loadDeployment(id: DeploymentId): Promise<StoredDeployment | undefined>;
  /** The deployment of an agent with this version, without its code. */
  findDeployment(agent: AgentId, version: number): Promise<Deployment | undefined>;
  /** An agent's deployments, newest first, without their code. */
  listDeployments(agent: AgentId, page?: PageOf): Promise<Paged<Deployment>>;
  /**
   * Removes an agent with everything of it: its deployments and their code, its secrets, and
   * its actors with their conversations and their mailboxes. All of it, or none. It gives the
   * deployments and the actors that went, or undefined when there is no such agent.
   */
  deleteAgent(
    id: AgentId,
  ): Promise<{ readonly deployments: DeploymentId[]; readonly actors: ActorId[] } | undefined>;

  // API keys

  addKey(key: StoredKey): Promise<void>;
  loadKey(id: KeyId): Promise<StoredKey | undefined>;
  /** Every key, in the order they were made. */
  listKeys(): Promise<StoredKey[]>;
  /** Removes keys: from then on they are not known. */
  removeKeys(ids: readonly KeyId[]): Promise<void>;
  /** Notes when a request last came with a key. */
  touchKey(id: KeyId, at: number): Promise<void>;

  // Secrets

  /** Keeps a sealed secret, in place of the one of its name the agent had. */
  setSecret(secret: SealedSecret): Promise<void>;
  getSecret(agent: AgentId, name: string): Promise<SealedSecret | undefined>;
  /** The names of an agent's secrets, in order. */
  secretNames(agent: AgentId): Promise<string[]>;
  /** False when the agent had none of that name. */
  deleteSecret(agent: AgentId, name: string): Promise<boolean>;
  /** Every secret there is, for sealing them again with another key. */
  allSecrets(): Promise<SealedSecret[]>;

  // Actors

  /**
   * Keeps a new actor, idle and with nothing said. `configurationGiven` is its configuration
   * as it was given. When it has an external ID that an actor of its agent has already, that
   * actor is given back and nothing is kept. Rejects with `NameTaken` when its name is
   * another's.
   */
  createActor(
    actor: Actor,
    configurationGiven?: Json | null,
  ): Promise<{ readonly record: ActorRecord; readonly created: boolean }>;
  loadActor(id: ActorId): Promise<ActorRecord | undefined>;
  /** The actor of an agent with this external ID, if it has one. */
  findActor(agent: AgentId, externalId: string): Promise<ActorRecord | undefined>;
  /** Actors, newest first. */
  listActors(query?: ActorsQuery): Promise<Paged<Actor>>;
  /**
   * Stores `change`, if the actor is still at `epoch`. Rejects with `StaleEpoch` when it is
   * not, and with `NameTaken` when the change names the actor as another of its agent is.
   */
  commit(id: ActorId, epoch: number, change: Change): Promise<void>;

  /**
   * Puts an input in the mailbox. It names no epoch: an input may arrive at any moment, a turn
   * going on or none. `duplicate` when the actor has one of its external ID already.
   */
  addInput(input: Input): Promise<'accepted' | 'duplicate'>;
  /** The input the actor was sent with this external ID, if it was sent one. */
  findInput(actor: ActorId, externalId: string): Promise<InputId | undefined>;
  /** What waits in the mailbox, oldest first. */
  pendingInputs(actor: ActorId): Promise<Input[]>;
  /**
   * What an actor was sent, newest first: only what waits with `pending` true, only what a
   * turn took with it false, and both without it.
   */
  listInputs(
    actor: ActorId,
    query?: PageOf & { readonly pending?: boolean },
  ): Promise<Paged<Input>>;

  /**
   * A part of the conversation: the messages after `after` and before `before`, `limit` at
   * most, in order, or from the newest back with `order` `desc`.
   */
  conversation(
    actor: ActorId,
    part?: {
      readonly after?: number;
      readonly before?: number;
      readonly limit?: number;
      readonly order?: 'asc' | 'desc';
    },
  ): Promise<ConversationEntry[]>;

  /** The actors with something owed: a turn under way, or mail that waits. */
  unfinished(): Promise<ActorId[]>;

  close(): Promise<void>;
}
