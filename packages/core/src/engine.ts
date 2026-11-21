// The engine: what is asked of actors from outside, and the drivers that do it.
//
// It keeps a driver for each actor that has something to do, or had lately. Everything else of
// an actor is in the store. When the process stops, with or without warning, nothing is lost
// that was stored: the next engine on the store picks up what is owed.

import type { ModelRunner } from '@acentric/ai';
import { makeId } from '@acentric/protocol';
import type {
  Actor,
  ActorId,
  AgentDefinition,
  AgentId,
  DeploymentId,
  DeploymentRef,
  ExternalId,
  Input,
  InputId,
  Json,
  Name,
  Reasoning,
} from '@acentric/protocol';

import { MemoryBus } from './bus.ts';
import type { EventBus } from './bus.ts';
import { ActorDriver, contentOf } from './driver.ts';
import type { Clock, Host, Timer } from './driver.ts';
import { ActorArchived, ActorNotFound, InvalidInput, Unavailable, UnknownInput } from './errors.ts';
import type { Executor } from './executor.ts';
import { Semaphore } from './limits.ts';
import { DEFAULT_RULES } from './machine.ts';
import type { Rules } from './machine.ts';
import type { Store } from './store.ts';

/** Ten random bytes. */
export type Entropy = () => Uint8Array;

export type EngineOptions = {
  readonly store: Store;
  readonly runner: ModelRunner;
  readonly executor: Executor;
  /** Without it, a bus of this process. */
  readonly bus?: EventBus;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly timer?: Timer;
  readonly rules?: Rules;
  /** How many actors are in a turn at once. The rest wait their turn, in order. 100 without it. */
  readonly maxConcurrentTurns?: number;
  /** How many actors with nothing to do keep their driver, for when they are next sent something. 1000 without it. */
  readonly maxHotActors?: number;
  /** Told of what a driver could not go on from. `console.error` without it. */
  readonly report?: (error: unknown) => void;
};

const wait: Timer = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

export class Engine {
  readonly #store: Store;
  readonly #executor: Executor;
  readonly #clock: Clock;
  readonly #entropy: Entropy;
  readonly #timer: Timer;
  readonly #host: Host;
  readonly #slots: Semaphore;
  readonly #maxHot: number;
  /** The drivers, the one touched longest ago first. */
  readonly #drivers = new Map<ActorId, ActorDriver>();
  readonly #loading = new Map<ActorId, Promise<ActorDriver>>();
  /** What each deployment's code says of itself. It never changes, so it is asked once. */
  readonly #definitions = new Map<DeploymentId, Promise<AgentDefinition>>();
  #closing = false;

  constructor(options: EngineOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#clock = options.clock ?? Date.now;
    this.#entropy = options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10)));
    this.#timer = options.timer ?? wait;
    this.#slots = new Semaphore(options.maxConcurrentTurns ?? 100);
    this.#maxHot = options.maxHotActors ?? 1000;
    const report =
      options.report ??
      ((error: unknown) => {
        console.error(error);
      });
    this.#host = {
      store: options.store,
      runner: options.runner,
      executor: options.executor,
      bus: options.bus ?? new MemoryBus(),
      clock: this.#clock,
      timer: this.#timer,
      rules: options.rules ?? DEFAULT_RULES,
      slots: this.#slots,
      definition: (deployment) => this.#definition(deployment),
      closing: () => this.#closing,
      report,
      rested: (driver) => {
        this.#rested(driver);
      },
    };
  }

  /** The bus the engine tells of every actor on. */
  get bus(): EventBus {
    return this.#host.bus;
  }

  /** How many actors have a driver now. */
  get hot(): number {
    return this.#drivers.size;
  }

  /**
   * Creates an actor on a deployment of its agent. With an external ID an actor of the agent
   * has already, that actor is given back and none is made.
   */
  async createActor(given: {
    readonly agent: AgentId;
    readonly deployment: DeploymentRef;
    readonly model: string;
    readonly reasoning?: Reasoning;
    readonly configuration?: Json;
    readonly name?: Name;
    readonly externalId?: ExternalId;
  }): Promise<{ readonly actor: Actor; readonly created: boolean }> {
    if (this.#closing) throw new Unavailable();
    const now = this.#clock();
    const { record, created } = await this.#store.createActor({
      id: makeId('actor', { now, random: this.#entropy() }),
      name: given.name ?? null,
      externalId: given.externalId ?? null,
      agent: given.agent,
      deployment: given.deployment,
      model: given.model,
      reasoning: given.reasoning ?? 'medium',
      configuration: given.configuration ?? null,
      status: 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: now,
      archivedAt: null,
    });
    return { actor: record.actor, created };
  }

  async getActor(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).record.actor;
  }

  /**
   * Sends an actor an input. It answers once the input is in the mailbox, not once it is read.
   * With an external ID the actor was sent before, nothing is stored and nothing of the agent's
   * is run: sending is safe to repeat.
   */
  async send(
    actorId: ActorId,
    sent: { readonly type: string; readonly payload?: Json; readonly externalId?: ExternalId },
  ): Promise<{ readonly input: InputId; readonly status: 'accepted' | 'duplicate' }> {
    if (this.#closing) throw new Unavailable();
    const driver = await this.#driver(actorId);
    const { actor } = driver.record;
    if (actor.status === 'archived') throw new ActorArchived(actorId);

    if (sent.externalId !== undefined) {
      const known = await this.#store.findInput(actorId, sent.externalId);
      if (known !== undefined) return { input: known, status: 'duplicate' };
    }

    const definition = await this.#definition(actor.deployment.id);
    if (!definition.inputs.some((declared) => declared.type === sent.type)) {
      throw new UnknownInput(sent.type);
    }
    // The agent's own code turns what was sent into what the model reads.
    const handled = await this.#executor.call(
      actor.deployment.id,
      `inputs.${sent.type}.handler`,
      sent.payload ?? null,
      { agent: actor.agent, actor: actor.id, configuration: actor.configuration },
      new AbortController().signal,
    );
    if (!handled.ok) throw new InvalidInput(handled.error);

    const now = this.#clock();
    const input: Input = {
      id: makeId('input', { now, random: this.#entropy() }),
      actor: actorId,
      type: sent.type,
      externalId: sent.externalId ?? null,
      message: { role: 'user', content: contentOf(handled.value) },
      receivedAt: now,
      deliveredAt: null,
    };
    if ((await this.#store.addInput(input)) === 'duplicate') {
      // The same input was sent twice at once, and the other got there first.
      const first = await this.#store.findInput(actorId, input.externalId ?? '');
      return { input: first ?? input.id, status: 'duplicate' };
    }
    // The driver may have been given up while the agent's code ran: the one there is now has it.
    (await this.#driver(actorId)).receive(input);
    return { input: input.id, status: 'accepted' };
  }

  /** Ends the turn an actor is in. What waits in its mailbox stays, and starts the next. */
  async interrupt(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).interrupt();
  }

  /** Has an actor whose last turn failed try it again, with nothing new. */
  async retry(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).retry();
  }

  /** Puts an actor away: it takes no input until it is unarchived. A turn it is in is ended. */
  async archive(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).archive();
  }

  async unarchive(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).unarchive();
  }

  /**
   * Picks up every actor with something owed: what a process does when it starts. It returns
   * how many there were. They go on as turns come free, not all at once.
   */
  async recover(): Promise<number> {
    const owed = await this.#store.unfinished();
    for (const id of owed) (await this.#driver(id)).wake(true);
    return owed.length;
  }

  /** Resolves when nothing is being done for the actor, or for any actor when none is named. */
  async settled(id?: ActorId): Promise<void> {
    if (id !== undefined) {
      await (await this.#loading.get(id))?.settled();
      await this.#drivers.get(id)?.settled();
      return;
    }
    for (;;) {
      await Promise.allSettled(this.#loading.values());
      await Promise.all([...this.#drivers.values()].map((driver) => driver.settled()));
      const quiet = [...this.#drivers.values()].every((driver) => !driver.running);
      if (quiet && this.#loading.size === 0) return;
    }
  }

  /**
   * Shuts the engine down. Nothing new is begun. A call that is under way is given `graceMs`
   * to end and be stored, so that it is not made and paid for again. What is still under way
   * after that is given up: it stays owed, and the next engine on the store picks it up.
   */
  async close(options: { readonly graceMs?: number } = {}): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#slots.close();
    await Promise.allSettled(this.#loading.values());
    const drivers = [...this.#drivers.values()];
    for (const driver of drivers) driver.drain();

    const settled = Promise.all(drivers.map((driver) => driver.settled()));
    const grace = new AbortController();
    const first = await Promise.race([
      settled.then(() => 'settled'),
      this.#timer(options.graceMs ?? 10_000, grace.signal).then(() => 'late'),
    ]);
    grace.abort();
    if (first === 'late') for (const driver of drivers) driver.halt();
    await settled;
    for (const driver of drivers) driver.abandon(new Unavailable());
    this.#drivers.clear();
  }

  #definition(deployment: DeploymentId): Promise<AgentDefinition> {
    let definition = this.#definitions.get(deployment);
    if (definition === undefined) {
      definition = this.#executor.describe(deployment);
      this.#definitions.set(deployment, definition);
      // One that could not be read is asked for again the next time.
      definition.catch(() => this.#definitions.delete(deployment));
    }
    return definition;
  }

  /** The actor's driver: the one it has, or one made from the store. */
  async #driver(id: ActorId): Promise<ActorDriver> {
    const hot = this.#drivers.get(id);
    if (hot !== undefined && !hot.dead) {
      // Touched: it is the last to be given up.
      this.#drivers.delete(id);
      this.#drivers.set(id, hot);
      return hot;
    }
    let loading = this.#loading.get(id);
    if (loading === undefined) {
      loading = (async () => {
        const record = await this.#store.loadActor(id);
        if (record === undefined) throw new ActorNotFound(id);
        const driver = new ActorDriver(this.#host, record, await this.#store.pendingInputs(id));
        this.#drivers.set(id, driver);
        return driver;
      })().finally(() => this.#loading.delete(id));
      this.#loading.set(id, loading);
    }
    return loading;
  }

  /** A driver stopped. One that is dead is dropped, and those that rest are kept up to a number. */
  #rested(driver: ActorDriver): void {
    if (this.#drivers.get(driver.id) !== driver) return;
    if (driver.dead) {
      this.#drivers.delete(driver.id);
      return;
    }
    if (this.#drivers.size <= this.#maxHot) return;
    for (const [id, other] of this.#drivers) {
      if (this.#drivers.size <= this.#maxHot) break;
      if (other.resting) this.#drivers.delete(id);
    }
  }
}
