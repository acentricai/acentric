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
  MachineAgents,
  MachineId,
  SandboxProviderId,
  PrincipalRef,
  Role,
  Session,
  SessionId,
  StoppedOnMachine,
  TaskStatus,
  TaskStoppedBy,
  UsageGroup,
  UsageReport,
  User,
  UserId,
} from '@acentric/protocol';

import type { ActorRecord, Change, StoredCompaction } from './state.ts';
import type { UsageFilter, UsageRecord } from './usage.ts';

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

/**
 * A script of an actor's model, as a store keeps it: what it is run with, so that it runs the
 * same way every time it is run, and what it came to (see `code.ts`).
 */
export type StoredScript = {
  /** Where its clock starts. */
  readonly startedAt: number;
  /** What its random numbers are made from. */
  readonly seed: number;
  /** What there was for it to call when it started. */
  readonly catalog: Json;
  /** What it came to, once it has ended: what it returned, as JSON text, and all else it printed. */
  readonly kept: ScriptKept | null;
};

export type ScriptKept = {
  readonly ended: 'returned' | 'failed' | 'stopped';
  readonly value: string | null;
  readonly logs: string;
};

/** A call a script made, as a store keeps it: stored before the call is made. */
export type ScriptCall = {
  /** The script's own number for it: 1, 2, and on, in the order it made its calls. */
  readonly id: number;
  readonly name: string;
  /** What it was called with: JSON, as text. */
  readonly args: string;
  /** Whether it is safe to make again when the engine stopped with it under way. */
  readonly retrySafe: boolean;
  readonly startedAt: number;
  /**
   * Its result, once it has one: its place among the script's results, when it arrived, and
   * what it was. Null while the call is under way.
   */
  readonly done: { readonly seq: number; readonly at: number; readonly outcome: Json } | null;
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

/** A machine, as a store keeps it. */
export type StoredMachine = {
  readonly id: MachineId;
  readonly name: string;
  readonly agents: MachineAgents;
  /** The SHA-256 of the token its daemon may enrol with, in hex, and until when it works. */
  readonly tokenHash: string | null;
  readonly tokenExpiresAt: number | null;
  /** Its daemon's Ed25519 public key, as base64 of its SubjectPublicKeyInfo. Null until it enrols. */
  readonly publicKey: string | null;
  /** What its daemon last said of it. Null until it has connected once. */
  readonly os: string | null;
  readonly arch: string | null;
  readonly home: string | null;
  readonly hostname: string | null;
  readonly version: string | null;
  /** The SHA-256 of its daemon's program, in hex. */
  readonly build: string | null;
  /** The folder its daemon keeps commands in. */
  readonly tasksDir: string | null;
  readonly createdAt: number;
  readonly enrolledAt: number | null;
  readonly lastSeenAt: number | null;
  /** What it is as a sandbox. Null for a machine someone enrolled. */
  readonly sandbox: StoredSandbox | null;
};

/** What a machine that the engine made at a provider is, beyond a machine (see `sandboxes.ts`). */
export type StoredSandbox = {
  /** The provider account it was made in. */
  readonly provider: SandboxProviderId;
  /** The provider's own ID for it. Null until the provider has answered that it made it. */
  readonly sandboxId: string | null;
  readonly vcpu: number;
  readonly memoryGB: number;
  /** How many seconds it may be idle before it is stopped. */
  readonly idle: number;
  /** When its idle time runs out, as far as the engine set it. Null until it has. */
  readonly deadline: number | null;
};

/** An account at a provider of sandboxes, as a store keeps it. */
export type StoredSandboxProvider = {
  readonly id: SandboxProviderId;
  /** Which provider it is an account at. */
  readonly kind: string;
  readonly name: string;
  /** Its credential, sealed. Null for a provider that has none. */
  readonly credential: string | null;
  /** Who the provider says it belongs to. */
  readonly account: string | null;
  readonly createdAt: number;
};

/** What of a machine changes. A field that is absent stays as it is. */
export type MachinePatch = Partial<Omit<StoredMachine, 'id' | 'createdAt'>>;

/**
 * Where a command stands: `starting` until its machine has said that it has it, then
 * `running`. It ends as `exited` when it ended by itself, `stopped` when it was stopped,
 * `failed` when it could not be started, and `lost` when its machine no longer has it.
 */
export type CommandStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed' | 'lost';

/** A command on a machine, as a store keeps it. It is named by the actor and the task it is for. */
export type StoredCommand = {
  /** The actor it is for, or what stands in an actor's place for a machine's own commands. */
  readonly actor: string;
  readonly task: string;
  readonly machine: MachineId;
  readonly command: string;
  readonly cwd: string;
  /** Seconds it may run. Null for no limit. */
  readonly timeout: number | null;
  readonly status: CommandStatus;
  /** It was asked to be stopped: the asking is sent again when its machine connects. */
  readonly stopWanted: boolean;
  /** Its exit status. Null while it runs, and when it was killed and left none. */
  readonly exit: number | null;
  readonly stoppedBy: StoppedOnMachine | null;
  readonly ranMs: number | null;
  /** How much it wrote. */
  readonly bytes: number | null;
  readonly lines: number | null;
  /** The end of what it wrote. */
  readonly tail: string | null;
  /** The file all of its output is in, on the machine. */
  readonly log: string | null;
  /** Why it failed or was lost. */
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
};

/** A command to store: it is `starting`. */
export type NewCommand = Pick<
  StoredCommand,
  'actor' | 'task' | 'machine' | 'command' | 'cwd' | 'timeout' | 'startedAt'
>;

/** What of a command changes. A field that is absent stays as it is. */
export type CommandPatch = Partial<
  Pick<
    StoredCommand,
    | 'status'
    | 'stopWanted'
    | 'exit'
    | 'stoppedBy'
    | 'ranMs'
    | 'bytes'
    | 'lines'
    | 'tail'
    | 'log'
    | 'error'
    | 'endedAt'
  >
>;

/** How an actor is being stopped: put away too, or not, and by a person or by the actor that spawned it. */
export type Stopping = {
  readonly how: 'abort' | 'archive';
  readonly by: 'person' | 'parent';
};

/** What has a name that no other of its kind has. */
export type Named = 'actor' | 'agent' | 'account' | 'machine' | 'provider account' | 'subagent';

export class NameTaken extends Error {
  override readonly name = 'NameTaken';
  readonly code: ErrorCode = 'name_taken';
  constructor(name: string, of: Named = 'actor') {
    super(
      of === 'actor'
        ? `An actor of this agent is named ${name} already`
        : of === 'subagent'
          ? `The actor has a subagent ${name} already`
          : `${of === 'agent' || of === 'account' ? 'An' : 'A'} ${of} is named ${name} already`,
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
  /** The subagents of this actor. */
  readonly parent?: ActorId;
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
  /** An agent's actors, and every subagent under them, of whatever agent. */
  agentTree(id: AgentId): Promise<ActorId[]>;
  /**
   * Removes an agent with everything of it: its deployments and their code, its secrets, and
   * its actors with their conversations and their mailboxes, and the subagents under them, of
   * whatever agent, with theirs: what they worked for is gone. It is taken off every machine
   * that names it. All of it, or none. It gives the deployments and the actors that went, or
   * undefined when there is no such agent.
   */
  deleteAgent(
    id: AgentId,
  ): Promise<{ readonly deployments: DeploymentId[]; readonly actors: ActorId[] } | undefined>;
  /**
   * Deletes an actor and every subagent under it, with their conversations, mailboxes,
   * compactions, tasks, scripts and commands, and their hold on blobs. What they cost stays in
   * the usage. All of it, or none. It gives the actors that went, the one asked for first, or
   * undefined when there is no such actor.
   */
  deleteActor(id: ActorId): Promise<ActorId[] | undefined>;
  /** Actors that are no subagent, archived before `before`: the longest archived first. */
  archivedBefore(before: number, limit: number): Promise<ActorId[]>;
  /** Removes sessions and links that expired before `now`, and says how many of each went. */
  removeExpired(now: number): Promise<{ readonly sessions: number; readonly links: number }>;
  /** Removes audit events from before `before`, the oldest first, `limit` at most: how many went. */
  pruneAudit(before: number, limit: number): Promise<number>;
  /** Removes usage from before `before`, the oldest first, `limit` at most: how many went. */
  pruneUsage(before: number, limit: number): Promise<number>;

  /**
   * Gives an agent a model account, or with null none: it then uses its provider's default.
   * It gives the agent as it then is, or undefined when there is no such agent.
   */
  setAgentAccount(agent: AgentId, account: AccountId | null): Promise<Agent | undefined>;

  // Model accounts

  /**
   * Keeps a new account. Rejects with `NameTaken` when its name is another's. One that is its
   * provider's default is the only one: no other of the provider is, in the same write.
   */
  addAccount(account: StoredAccount): Promise<void>;
  loadAccount(id: AccountId): Promise<StoredAccount | undefined>;
  /** Every account, in the order they were made. */
  listAccounts(): Promise<StoredAccount[]>;
  /**
   * Keeps an account as it now is, in place of how it was. Rejects with `NameTaken` when its
   * name is now another's. One that is its provider's default is the only one, as for
   * `addAccount`.
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
  /** Writes down a call of a model that no step of a turn ends: one that compacted a conversation. */
  recordUsage(record: UsageRecord): Promise<void>;

  // Compactions (see `compaction.ts`). One is kept by the step that makes it.

  /** The newest compaction of an actor's conversation, with what stands for the older part. */
  latestCompaction(actor: ActorId): Promise<StoredCompaction | undefined>;
  /** The compactions of an actor's conversation, newest first. */
  listCompactions(actor: ActorId): Promise<StoredCompaction[]>;

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
   * as it was given, and `env` the variables its commands are run with, sealed. When it has an
   * external ID that an actor of its agent has already, that actor is given back and nothing
   * is kept. Rejects with `NameTaken` when its name is another's.
   */
  createActor(
    actor: Actor,
    configurationGiven?: Json | null,
    env?: string | null,
    /** For a subagent: the call of its parent's model that spawned it. */
    spawnedBy?: string | null,
  ): Promise<{ readonly record: ActorRecord; readonly created: boolean }>;
  /**
   * The subagent an actor gave a name, with the call that spawned it. An actor's subagents
   * have each a name of their own: a second of one name is refused with `NameTaken`.
   */
  findChild(
    parent: ActorId,
    name: string,
  ): Promise<{ readonly actor: Actor; readonly spawnedBy: string | null } | undefined>;
  /** The subagents of an actor, in the order they were spawned. */
  listChildren(parent: ActorId): Promise<Actor[]>;
  /**
   * Writes down that an actor is being stopped, and by whom, or with null that it has been:
   * what a process that starts looks for, to go on stopping it.
   */
  setStopping(actor: ActorId, stopping: Stopping | null): Promise<void>;
  /** The actors that were being stopped, each with how and by whom. */
  listStopping(): Promise<({ readonly actor: ActorId } & Stopping)[]>;
  /** The variables an actor's commands are run with, sealed. Null for an actor that has none. */
  actorEnv(actor: ActorId): Promise<string | null>;
  /**
   * Keeps the variables an actor's commands are run with, sealed, with their names, in place
   * of all it had. It names no epoch: they are changed at any moment, a turn going on or none.
   * False, and nothing is kept, for an actor that is not there or has no machine.
   */
  setActorEnv(actor: ActorId, names: readonly string[], sealed: string | null): Promise<boolean>;
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
  quietInputs(actor: ActorId, only?: readonly string[]): Promise<void>;

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

  // Scripts: what a script of a model is run with, and every call it made (see `code.ts`)

  /**
   * Stores what a task's script is run with, once, and gives what is stored: a script that is
   * run again is run with what it was first run with.
   */
  startScript(
    actor: ActorId,
    task: string,
    script: Pick<StoredScript, 'startedAt' | 'seed' | 'catalog'>,
  ): Promise<StoredScript>;
  loadScript(actor: ActorId, task: string): Promise<StoredScript | undefined>;
  /** Keeps what a script came to, for a later script to read. */
  endScript(actor: ActorId, task: string, kept: ScriptKept): Promise<void>;
  /** The calls a script made, in the order it made them. */
  listScriptCalls(actor: ActorId, task: string): Promise<ScriptCall[]>;
  /** Stores a call before it is made. */
  addScriptCall(actor: ActorId, task: string, call: Omit<ScriptCall, 'done'>): Promise<void>;
  /** Stores a call's result, with its place among its script's results. */
  finishScriptCall(
    actor: ActorId,
    task: string,
    id: number,
    done: NonNullable<ScriptCall['done']>,
  ): Promise<void>;

  // Machines: the computers commands run on (see `machines.ts`)

  /** Keeps a new machine. Rejects with `NameTaken` when its name is another's. */
  addMachine(machine: StoredMachine): Promise<void>;
  loadMachine(id: MachineId): Promise<StoredMachine | undefined>;
  findMachine(name: string): Promise<StoredMachine | undefined>;
  /** Every machine, in the order they were added. */
  listMachines(): Promise<StoredMachine[]>;
  /**
   * The machines actors work on, once each: those of the actors of `agents` that are not
   * archived, and those of `actors`.
   */
  machinesOfActors(query: {
    readonly agents: readonly AgentId[];
    readonly actors: readonly ActorId[];
  }): Promise<MachineId[]>;
  /**
   * Changes what a patch names of a machine, and gives the machine as it then is. Undefined
   * when there is no such machine. Rejects with `NameTaken` when its name is now another's.
   */
  changeMachine(id: MachineId, patch: MachinePatch): Promise<StoredMachine | undefined>;
  /**
   * Takes a daemon's public key for a machine whose token has this hash, and works at `at`.
   * The token is gone with it: of two that enrol with one token, one does. False, and nothing
   * is kept, for any other.
   */
  enrolMachine(id: MachineId, tokenHash: string, publicKey: string, at: number): Promise<boolean>;
  /**
   * Removes a machine. The commands that had not ended there are `lost`, with this to say why,
   * and are given. Undefined when there is no such machine.
   */
  removeMachine(
    id: MachineId,
    lost: { readonly error: string; readonly endedAt: number },
  ): Promise<StoredCommand[] | undefined>;

  // Accounts at providers of sandboxes (see `sandboxes.ts`)

  /** Keeps a new account. Rejects with `NameTaken` when its name is another's. */
  addSandboxProvider(provider: StoredSandboxProvider): Promise<void>;
  loadSandboxProvider(id: SandboxProviderId): Promise<StoredSandboxProvider | undefined>;
  /** Every account, in the order they were added. */
  listSandboxProviders(): Promise<StoredSandboxProvider[]>;
  /**
   * Forgets an account that no machine was made in. `in_use`, and nothing is forgotten, while
   * one was: looked at and forgotten in one step, so none is made in it meanwhile.
   */
  removeSandboxProvider(id: SandboxProviderId): Promise<'removed' | 'in_use' | 'missing'>;
  /**
   * Says what a machine is as a sandbox, when the account it names is there. False, and
   * nothing is kept, when there is no such machine or no such account.
   */
  setSandbox(id: MachineId, sandbox: StoredSandbox): Promise<boolean>;

  // Commands: what machines run (see `machines.ts`)

  /**
   * Stores a command before its machine is asked to run it, unless there is one of its actor
   * and task already: that one is given, and nothing is stored.
   */
  addCommand(
    command: NewCommand,
  ): Promise<{ readonly command: StoredCommand; readonly created: boolean }>;
  /**
   * Stores a command that is for no actor, under `actor`, and names it: `c` and its number
   * among those. Counted and stored in one step, so no two take one name.
   */
  addOwnCommand(command: Omit<NewCommand, 'task'>): Promise<StoredCommand>;
  loadCommand(actor: string, task: string): Promise<StoredCommand | undefined>;
  /** The commands that have not ended, on one machine. */
  openCommands(machine: MachineId): Promise<StoredCommand[]>;
  /** The commands of `actor` on a machine, newest first, at most `limit`. */
  listCommands(actor: string, machine: MachineId, limit: number): Promise<StoredCommand[]>;
  /**
   * Changes what a patch names of a command, when its status is one of `from`, or whatever its
   * status without that. False, and nothing is changed, otherwise: so an ending is stored once.
   */
  changeCommand(
    actor: string,
    task: string,
    patch: CommandPatch,
    from?: readonly CommandStatus[],
  ): Promise<boolean>;

  close(): Promise<void>;
}
