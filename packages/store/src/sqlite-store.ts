// The store on SQLite: one file, and the engine's only truth.
//
// The database is on threads of its own, so the engine never waits for the disk: one thread
// writes, and one only reads, so that a list or a long conversation does not wait behind a
// write. What the engine asks is sent to a thread, and the answer comes back as a promise.

import { Worker } from 'node:worker_threads';

import { NameTaken, OutOfOrder, StaleEpoch } from '@acentric/core';
import type { ActorRecord, Change, SealedSecret, Store, StoredDeployment } from '@acentric/core';
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
      const of = refused.args[1] === 'agent' ? 'agent' : 'actor';
      waiting.reject(new NameTaken(String(refused.args[0]), of));
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

  listAgents(): Promise<Agent[]> {
    return this.#read.ask('listAgents' satisfies Operation);
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

  createActor(
    actor: Actor,
    configurationGiven: Json | null = null,
  ): Promise<{ readonly record: ActorRecord; readonly created: boolean }> {
    return this.#write.ask('createActor' satisfies Operation, actor, configurationGiven);
  }

  findActor(agent: AgentId, externalId: string): Promise<ActorRecord | undefined> {
    return this.#write.ask('findActor' satisfies Operation, agent, externalId);
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

  conversation(
    actor: ActorId,
    part?: { readonly after?: number; readonly limit?: number },
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
