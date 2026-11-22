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
  Account,
  AccountId,
  Actor,
  ActorId,
  Agent,
  AgentId,
  ConversationEntry,
  Deployment,
  DeploymentId,
  ErrorCode,
  ImagePart,
  Input,
  InputId,
  Json,
  AuditEvent,
  InviteId,
  Key,
  KeyId,
  PrincipalRef,
  Role,
  Session,
  SessionId,
  TaskStatus,
  TaskStoppedBy,
  UsageGroup,
  UsageReport,
  User,
  UserId,
} from '@acentric/protocol';

import type { ActorRecord, Change } from './state.ts';
import type { UsageFilter } from './usage.ts';

/** A commit named an epoch that has passed: something else has written to the actor since. */
export class StaleEpoch extends Error {
  override readonly name = 'StaleEpoch';
  constructor(actor: ActorId, read: number, now: number) {
    super(`${actor} was read at epoch ${String(read)} and is at ${String(now)}`);
  }
}

/** The name is another's: another actor's of the same agent, or another agent's. */
/** A task, as a store keeps it. */
export type StoredTask = {
  readonly actor: ActorId;
  /** Its ID among its actor's, such as `b3`. */
  readonly id: string;
  readonly kind: string;
  /** What it was started with, as its kind made it of the model's arguments. */
  readonly input: Json;
  readonly status: TaskStatus;
  readonly stoppedBy: TaskStoppedBy | null;
  /** The tool call that started it. */
  readonly callId: string;
  /** Whether that call still waits for it. */
  readonly attached: boolean;
  /** When the call stops waiting. Null for one nothing waits for. */
  readonly waitUntil: number | null;
  /** When it is stopped for running too long. Null for no limit. */
  readonly timeoutAt: number | null;
  /** What it came to. Null while it runs. */
  readonly result: string | null;
  /** The result as a notice carries it, when its kind cut it itself. */
  readonly summary: string | null;
  /** The images whose places are marked in the result. */
  readonly images: readonly ImagePart[];
  readonly startedAt: number;
  readonly endedAt: number | null;
};

/** A task to store: everything but its ID, which the store gives it. */
export type NewTask = Pick<
  StoredTask,
  'actor' | 'kind' | 'input' | 'callId' | 'attached' | 'waitUntil' | 'timeoutAt' | 'startedAt'
> & {
  /** What its ID starts with: its kind's letter. */
  readonly prefix: string;
};

/** How a task ended, as it is stored. */
export type TaskEnding = Pick<StoredTask, 'result' | 'summary' | 'images'> & {
  readonly status: Exclude<TaskStatus, 'running'>;
  readonly stoppedBy: TaskStoppedBy | null;
  readonly endedAt: number;
};

/** A blob, as a store knows it: never its bytes. */
export type StoredBlob = {
  /** The SHA-256 of its bytes, in hex. */
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
  readonly createdAt: number;
};

export class NameTaken extends Error {
  override readonly name = 'NameTaken';
  readonly code: ErrorCode = 'name_taken';
  constructor(name: string, of: 'actor' | 'agent' | 'account' = 'actor') {
    super(
      of === 'actor'
        ? `An actor of this agent is named ${name} already`
        : `An ${of} is named ${name} already`,
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

/** A model account as the store keeps it: its credential sealed, never the credential. */
export type StoredAccount = {
  /** The account, but for which agents were given it: that is asked of the agents. */
  readonly account: Omit<Account, 'agents'>;
  readonly sealed: string;
};

/** The email is another person's. */
export class EmailTaken extends Error {
  override readonly name = 'EmailTaken';
  readonly code: ErrorCode = 'conflict';
  constructor(email: string) {
    super(`A person signs in as ${email} already`);
  }
}

/** A person as the store keeps them: with what tells their password is the one, never it. */
export type StoredUser = {
  readonly user: User;
  /** The hash of their password, with what it was made by. */
  readonly password: string;
};

/** A session as the store keeps it: never its token, only what tells it is the one. */
export type StoredSession = {
  readonly session: Session;
  /** The SHA-256 of the token's secret part, in hex. */
  readonly hash: string;
};

/**
 * A link that is used once: the one that makes an engine's owner, an invite, or one that sets
 * a password again. The link itself is not kept, only what tells it is the one.
 */
export type StoredLink = {
  readonly id: InviteId;
  readonly kind: 'setup' | 'invite' | 'reset';
  readonly hash: string;
  /** For a setup or an invite: the role of the account it makes. */
  readonly role: Role | null;
  /** For a reset: whose password it sets. */
  readonly user: UserId | null;
  /** For an invite: who it was made for, as its maker noted. */
  readonly note: string | null;
  readonly createdBy: PrincipalRef;
  readonly createdAt: number;
  readonly expiresAt: number;
};

/** What a link does when it is used. */
export type Redeem =
  | { readonly addUser: StoredUser }
  | { readonly setPassword: { readonly user: UserId; readonly password: string } };

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

  /**
   * Gives an agent a model account, or with null none: it then uses its provider's default.
   * It gives the agent as it then is, or undefined when there is no such agent.
   */
  setAgentAccount(agent: AgentId, account: AccountId | null): Promise<Agent | undefined>;

  // Model accounts

  /** Keeps a new account. Rejects with `NameTaken` when its name is another's. */
  addAccount(account: StoredAccount): Promise<void>;
  loadAccount(id: AccountId): Promise<StoredAccount | undefined>;
  /** Every account, in the order they were made. */
  listAccounts(): Promise<StoredAccount[]>;
  /**
   * Keeps an account as it now is, in place of how it was. Rejects with `NameTaken` when its
   * name is now another's.
   */
  saveAccount(account: StoredAccount): Promise<void>;
  removeAccount(id: AccountId): Promise<void>;
  /** The agents that were given an account. */
  agentsOf(account: AccountId): Promise<AgentId[]>;

  // Usage

  /**
   * What was used, added up: every call of a model that a filter leaves, and by a group as
   * well when one is asked for. A call is written with the step that ends it (see `commit`).
   */
  usage(filter?: UsageFilter, by?: UsageGroup): Promise<UsageReport>;

  // Blobs: the images and files of conversations, whose bytes are kept apart (see `blobs.ts`)

  /**
   * Says that an actor refers to a blob, from now on. The media type is the one the actor
   * first gave it. False, and nothing is kept, when there is no such actor.
   */
  addBlob(actor: ActorId, blob: StoredBlob): Promise<boolean>;
  /** A blob an actor refers to. Undefined when it refers to none of that name. */
  blobOf(actor: ActorId, digest: string): Promise<StoredBlob | undefined>;
  /**
   * Forgets every blob that no actor refers to, and gives their names. An actor's blobs are
   * no longer referred to by it once it is deleted.
   */
  dropUnreferencedBlobs(): Promise<string[]>;
  /** The name of every blob that is known. */
  listBlobs(): Promise<string[]>;

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

  // People

  /** Keeps a new person. Rejects with `EmailTaken` when their email is another's. */
  addUser(user: StoredUser): Promise<void>;
  loadUser(id: UserId): Promise<StoredUser | undefined>;
  /** The person who signs in as this email. */
  findUser(email: string): Promise<StoredUser | undefined>;
  /** Everyone, in the order they were made. */
  listUsers(): Promise<User[]>;
  /** Keeps a person as they now are, in place of how they were. Nothing when they are gone. */
  saveUser(user: StoredUser): Promise<void>;
  /** Removes a person and their sessions. */
  removeUser(id: UserId): Promise<void>;

  addSession(session: StoredSession): Promise<void>;
  loadSession(id: SessionId): Promise<StoredSession | undefined>;
  /** A person's sessions, in the order they were made. */
  listSessions(user: UserId): Promise<Session[]>;
  /** Notes when a session was last used, and until when it now lasts. */
  touchSession(id: SessionId, lastUsedAt: number, expiresAt: number): Promise<void>;
  removeSession(id: SessionId): Promise<void>;
  /** Removes a person's sessions, but for the one that is kept. */
  removeSessions(user: UserId, keep?: SessionId): Promise<void>;

  addLink(link: StoredLink): Promise<void>;
  loadLink(id: InviteId): Promise<StoredLink | undefined>;
  /** The links of a kind, in the order they were made. */
  listLinks(kind: StoredLink['kind']): Promise<StoredLink[]>;
  /** False when there was none. */
  removeLink(id: InviteId): Promise<boolean>;
  /**
   * Uses a link: does what it is for and removes it, both or neither. `gone` when the link is
   * not there any more, so that of two who use it at once, one does. Rejects with
   * `EmailTaken` when it was to make a person whose email is another's: the link stays.
   */
  redeemLink(id: InviteId, redeem: Redeem): Promise<'done' | 'gone'>;

  // The audit log

  addAuditEvent(event: AuditEvent): Promise<void>;
  /** What was done, newest first: all of it, or what was done of one kind. */
  listAuditEvents(query?: PageOf & { readonly action?: string }): Promise<Paged<AuditEvent>>;

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

  /**
   * Marks everything that waits in an actor's mailbox quiet: it starts no turn, and joins the
   * next one that something else starts.
   */
  quietInputs(actor: ActorId): Promise<void>;

  /** The actors with something owed: a turn under way, or mail that waits and is not quiet. */
  unfinished(): Promise<ActorId[]>;

  // Tasks: work an actor's model started that may go on after its call (see `tasks.ts`)

  /**
   * Stores a task before its work starts, and names it: its kind's prefix and its number
   * among its actor's tasks of that kind. A call that started one already is given that one,
   * and nothing is stored: a call that is made again finds its task.
   */
  startTask(task: NewTask): Promise<StoredTask>;
  loadTask(actor: ActorId, id: string): Promise<StoredTask | undefined>;
  /** The task a tool call started, if it started one. */
  taskOfCall(actor: ActorId, callId: string): Promise<StoredTask | undefined>;
  /** An actor's tasks, newest first. With `running`, only those under way. */
  listTasks(actor: ActorId, query?: { readonly running?: boolean }): Promise<StoredTask[]>;
  /** Every task that is under way, of every actor: what a start watches again. */
  runningTasks(): Promise<StoredTask[]>;
  /** Lets go of a task its call waits for. False when it had ended, or was let go of already. */
  detachTask(actor: ActorId, id: string): Promise<boolean>;
  /** Lets go of every task of an actor that a call still waits for, and gives them. */
  detachTasks(actor: ActorId): Promise<StoredTask[]>;
  /**
   * Stores how a task ended, once: nothing is stored for one that had ended. `notice` is put
   * in its actor's mailbox with it, in the same step, when no call waits for the task any
   * more: so its ending is told once, by its call's result or by its notice.
   */
  endTask(
    actor: ActorId,
    id: string,
    end: TaskEnding,
    notice: Input | null,
  ): Promise<{ readonly ended: boolean; readonly notified: boolean }>;

  close(): Promise<void>;
}
