// The engine: what is asked of actors from outside, and the drivers that do it.
//
// It keeps a driver for each actor that has something to do, or had lately. Everything else of
// an actor is in the store. When the process stops, with or without warning, nothing is lost
// that was stored: the next engine on the store picks up what is owed.

import { createHash } from 'node:crypto';

import { bindsReasoning, builtInProviders } from '@acentric/ai';
import type { ModelRunner, Providers } from '@acentric/ai';
import {
  SUPPORTED_BUNDLE_PROTOCOLS,
  agentDefinitionSchema,
  supportsBundleProtocol,
} from '@acentric/protocol';
import type {
  AbortResponse,
  Actor,
  ActorId,
  Agent,
  AgentDefinition,
  AgentId,
  BundleManifest,
  CallIssue,
  ContentPart,
  ConversationEntry,
  Deployment,
  DeploymentId,
  DeploymentRef,
  ExternalId,
  Input,
  InputId,
  Json,
  Name,
  PrincipalRef,
  Reasoning,
  UsageGroup,
  UsageReport,
} from '@acentric/protocol';

import type { Access } from './accounts.ts';
import { Blobs } from './blobs.ts';
import { Tasks } from './tasks.ts';
import type { EngineTool, TaskKind, TaskTimes } from './tasks.ts';
import type { BlobStore } from './blobs.ts';
import { MemoryBus } from './bus.ts';
import type { EventBus } from './bus.ts';
import { ActorDriver, contentOf } from './driver.ts';
import type { ActorUpdate, Clock, Host, Timer } from './driver.ts';
import {
  ActorArchived,
  ActorNotFound,
  AgentNotFound,
  CodeUnavailable,
  InvalidAgent,
  InvalidConfiguration,
  InvalidInput,
  Unavailable,
  UnknownInput,
  UnsupportedFeature,
  UnsupportedProtocol,
} from './errors.ts';
import { contextOf, issuesText } from './executor.ts';
import type { CallContext, CallResult, Executor } from './executor.ts';
import { Semaphore } from './limits.ts';
import { IdSource } from './ids.ts';
import { DEFAULT_RULES } from './machine.ts';
import type { Rules } from './machine.ts';
import type { Secrets } from './secrets.ts';
import type { ActorsQuery, PageOf, Paged, Store } from './store.ts';
import type { UsageFilter } from './usage.ts';

/**
 * Gives what an actor's model is called with: a runner, or a runner and the model account it
 * is of. It is asked at every call, so it is quick to answer. It throws, or rejects, with why,
 * when the model cannot be called at all.
 */
export type RunnerSource = (
  actor: Actor,
  definition: AgentDefinition,
) => ModelRunner | Access | Promise<ModelRunner | Access>;

/** Ten random bytes. */
export type Entropy = () => Uint8Array;

export type EngineOptions = {
  readonly store: Store;
  /**
   * What calls the model: one runner for every actor, or what gives each actor the runner of
   * its agent's provider (see `providerRunners`).
   */
  readonly runner: ModelRunner | RunnerSource;
  readonly executor: Executor;
  /**
   * The providers an agent may name. Those there are, without it. An agent of a provider that
   * is not among them is refused when it is deployed.
   */
  readonly providers?: Providers;
  /**
   * What an agent may use that not every engine has, by name, such as `machine`. An agent
   * that uses one that is not here is refused when it is deployed. None, without it.
   */
  readonly features?: readonly string[];
  /** The agents' secrets, for saying which of those a deploy names are not set. */
  readonly secrets?: Secrets;
  /**
   * Where the bytes of images and files are kept, apart from conversations (see `blobs.ts`).
   * Without it they stay in their messages, as an agent's code gave them.
   */
  readonly blobs?: BlobStore;
  /**
   * The kinds of work a model can start that may go on after the call that started it (see
   * `tasks.ts`), such as a command on a machine. None, without it.
   */
  readonly kinds?: readonly TaskKind[];
  /** How long a call waits for its task, and the like. For tests. */
  readonly taskTimes?: Partial<TaskTimes>;
  /** Without it, a bus of this process. */
  readonly bus?: EventBus;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly timer?: Timer;
  readonly rules?: Rules;
  /**
   * How long a function of an agent's code that is no tool may take: an input's handler, or a
   * check of a configuration. One that takes longer is given up, and fails. 30 seconds
   * without it. A tool has no limit: it ends when it ends, or when its turn is interrupted.
   */
  readonly codeTimeoutMs?: number;
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

/**
 * The text of a message sent to an agent that has no `message` input of its own: what was
 * sent is an object with a `text`, and nothing else.
 */
function plainMessage(payload: Json): string {
  const issues: CallIssue[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    issues.push({ message: 'A message is an object with a `text`', path: [] });
  } else {
    if (typeof payload['text'] !== 'string') {
      issues.push({ message: '`text` is a string', path: ['text'] });
    }
    for (const key of Object.keys(payload)) {
      if (key !== 'text') {
        issues.push({ message: 'A message has a `text`, and nothing else', path: [key] });
      }
    }
  }
  if (issues.length > 0) {
    throw new InvalidInput(`The input is not what message takes. ${issuesText(issues)}`, issues);
  }
  return (payload as { readonly text: string }).text;
}

export class Engine {
  readonly #store: Store;
  readonly #executor: Executor;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #timer: Timer;
  readonly #host: Host;
  /** The images and files of conversations, whose bytes are kept apart. */
  readonly blobs: Blobs;
  /** The work models start that may go on after their calls. */
  readonly tasks: Tasks;
  readonly #slots: Semaphore;
  readonly #maxHot: number;
  /** The drivers, the one touched longest ago first. */
  readonly #drivers = new Map<ActorId, ActorDriver>();
  readonly #loading = new Map<ActorId, Promise<ActorDriver>>();
  readonly #providers: Providers;
  readonly #features: readonly string[];
  readonly #secrets: Secrets | undefined;
  readonly #codeTimeoutMs: number;
  /** The agents, as they were last read or written here. An engine is its store's only writer. */
  readonly #agents = new Map<AgentId, Agent>();
  /** Each deployment that was asked for, as it is stored. It never changes, so it is read once. */
  readonly #deployments = new Map<DeploymentId, Promise<Deployment>>();
  /** The deployments whose code the executor has been given. */
  readonly #loaded = new Map<DeploymentId, Promise<void>>();
  /** What names the instructions and tools of a definition, worked out once for each. */
  readonly #fingerprints = new WeakMap<AgentDefinition, string>();
  /** The deploys of each agent's name go one after another. */
  readonly #deploying = new Map<string, Promise<unknown>>();
  #closing = false;

  constructor(options: EngineOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#clock = options.clock ?? Date.now;
    this.#ids = new IdSource(options.entropy ?? (() => crypto.getRandomValues(new Uint8Array(10))));
    this.#timer = options.timer ?? wait;
    this.blobs = new Blobs({
      store: options.store,
      clock: this.#clock,
      ...(options.blobs === undefined ? {} : { bytes: options.blobs }),
    });
    this.#slots = new Semaphore(options.maxConcurrentTurns ?? 100);
    this.#maxHot = options.maxHotActors ?? 1000;
    this.#providers = options.providers ?? builtInProviders();
    this.#features = options.features ?? [];
    this.#secrets = options.secrets;
    this.#codeTimeoutMs = options.codeTimeoutMs ?? 30_000;
    const { runner } = options;
    const report =
      options.report ??
      ((error: unknown) => {
        console.error(error);
      });
    this.tasks = new Tasks({
      store: options.store,
      clock: this.#clock,
      inputId: (now) => this.#ids.make('input', now),
      keep: (actor, content) => this.blobs.keep(actor, content),
      report,
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      ...(options.taskTimes === undefined ? {} : { times: options.taskTimes }),
    });
    // A notice is in the mailbox already: its actor is told, and starts a turn for it.
    this.tasks.onNotice((notice) => {
      this.#driver(notice.actor)
        .then((driver) => {
          driver.receive(notice);
        })
        .catch((error: unknown) => {
          // An actor that is gone, or an engine that is going away, has nothing to tell.
          if (!(error instanceof ActorNotFound) && !this.#closing) report(error);
        });
    });
    this.#host = {
      store: options.store,
      tasks: this.tasks,
      access: async (actor, definition) => {
        const given = typeof runner === 'function' ? await runner(actor, definition) : runner;
        return 'run' in given ? { account: null, runner: given } : given;
      },
      call: (deployment, path, argument, context, signal) =>
        // A tool takes as long as it takes. Anything else of an agent's is to be quick.
        path.startsWith('tools.')
          ? this.#call(deployment, path, argument, context, signal)
          : this.#timed(deployment, path, argument, context, signal),
      blobs: this.blobs,
      bus: options.bus ?? new MemoryBus(),
      clock: this.#clock,
      timer: this.#timer,
      rules: options.rules ?? DEFAULT_RULES,
      slots: this.#slots,
      definition: (deployment) => this.#definition(deployment),
      active: async (agent) => (await this.#agent(agent))?.activeDeployment,
      version: async (agent, version) => {
        const found = await this.#store.findDeployment(agent, version);
        return found === undefined ? undefined : { id: found.id, version };
      },
      fingerprint: (definition, own) => this.#fingerprint(definition, own),
      bindsReasoning: (actor, definition) =>
        this.#providers.has(definition.provider) &&
        bindsReasoning(this.#providers.get(definition.provider), actor.modelId),
      withoutReasoning: (definition, message) =>
        this.#providers.has(definition.provider)
          ? this.#providers.get(definition.provider).withoutReasoning(message)
          : message,
      reasoningChange: (definition, model, reasoning) =>
        this.#providers.has(definition.provider)
          ? this.#providers.get(definition.provider).reasoningChange?.(model, reasoning)
          : undefined,
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
   * Deploys an agent: its code becomes a new deployment of the agent of that name, which is
   * made when there is none. The code is loaded and asked what it is before anything is kept,
   * and refused, with why, when it is not an agent this engine can run. Code that is the
   * agent's newest already makes no new deployment.
   *
   * The deployment becomes the active one unless `activate` is false. Actors that follow the
   * active deployment move to it as their next turns start.
   */
  deploy(given: {
    readonly agent: Name;
    readonly manifest: BundleManifest;
    readonly code: string;
    readonly activate?: boolean;
    readonly by?: PrincipalRef;
  }): Promise<{
    readonly agent: Agent;
    readonly deployment: Deployment;
    readonly created: boolean;
    readonly missingSecrets: string[];
  }> {
    if (this.#closing) return Promise.reject(new Unavailable());
    // One deploy of a name at a time: each is a version, counted from the one before it.
    const before = this.#deploying.get(given.agent) ?? Promise.resolve();
    const deployed = before.then(() => this.#deploy(given));
    const settled = deployed.catch(() => {});
    this.#deploying.set(given.agent, settled);
    void settled.then(() => {
      if (this.#deploying.get(given.agent) === settled) this.#deploying.delete(given.agent);
    });
    return deployed;
  }

  async #deploy(given: Parameters<Engine['deploy']>[0]) {
    const { manifest, code } = given;
    const activate = given.activate ?? true;
    if (!supportsBundleProtocol(manifest.protocol)) {
      throw new UnsupportedProtocol(
        `The code was built for bundle protocol ${String(manifest.protocol)}, and this engine runs ${SUPPORTED_BUNDLE_PROTOCOLS.join(', ')}`,
      );
    }
    const hash = createHash('sha256').update(code).digest('hex');
    const existing = await this.#store.findAgent(given.agent);
    const missing = async (agent: AgentId, definition: AgentDefinition) => {
      const named = definition.secrets ?? [];
      if (named.length === 0) return [];
      const set = new Set(await (this.#secrets?.names(agent) ?? this.#store.secretNames(agent)));
      return named.filter((name) => !set.has(name));
    };

    if (existing !== undefined) {
      const latest = await this.#deployment(existing.latestDeployment.id);
      if (latest.hash === hash) {
        // Nothing new: the agent's newest is this code. It is made active when that is asked.
        const agent =
          activate && existing.activeDeployment.id !== latest.id
            ? await this.activate(existing.id, latest.version)
            : existing;
        this.#agents.set(agent.id, agent);
        return {
          agent,
          deployment: latest,
          created: false,
          missingSecrets: await missing(agent.id, latest.definition),
        };
      }
    }

    const now = this.#clock();
    const agentId = existing?.id ?? this.#ids.make('agent', now);
    const id = this.#ids.make('deployment', now);
    const refuse = async (error: Error): Promise<never> => {
      await this.#executor.unload(id);
      throw error;
    };

    let definition: AgentDefinition;
    try {
      const said = await this.#executor.load(id, {
        code,
        agent: { id: agentId, name: given.agent },
      });
      definition = agentDefinitionSchema.parse(said);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unsupported = (error as { code?: unknown }).code === 'unsupported_protocol';
      return refuse(unsupported ? new UnsupportedProtocol(message) : new InvalidAgent(message));
    }

    if (!this.#providers.has(definition.provider)) {
      const has = this.#providers.list().map((provider) => provider.id);
      return refuse(
        new UnsupportedFeature(
          `The agent is of the provider ${definition.provider}, which this engine has not: it has ${has.join(', ')}`,
        ),
      );
    }
    if (existing !== undefined && existing.provider !== definition.provider) {
      return refuse(
        new InvalidAgent(
          `The agent ${existing.name} is of the provider ${existing.provider}, and this code is of ${definition.provider}: an agent's provider does not change`,
        ),
      );
    }
    const lacking = (definition.features ?? []).filter(
      (feature) => !this.#features.includes(feature),
    );
    if (lacking.length > 0) {
      return refuse(
        new UnsupportedFeature(
          `The agent uses ${lacking.join(', ')}, which this engine does not have yet`,
        ),
      );
    }
    try {
      // What the agent asks of its provider is kept as the provider read it.
      const options = this.#providers
        .get(definition.provider)
        .parseOptions(definition.providerOptions);
      const { providerOptions: _asked, ...rest } = definition;
      definition = Object.keys(options).length > 0 ? { ...rest, providerOptions: options } : rest;
    } catch (error) {
      return refuse(new InvalidAgent(error instanceof Error ? error.message : String(error)));
    }

    const version = (existing?.latestDeployment.version ?? 0) + 1;
    const ref: DeploymentRef = { id, version };
    const deployment: Deployment = {
      id,
      agent: agentId,
      version,
      hash,
      manifest,
      definition,
      createdBy: given.by ?? { type: 'system' },
      createdAt: now,
    };
    const agent: Agent = {
      id: agentId,
      name: given.agent,
      provider: definition.provider,
      activeDeployment: activate || existing === undefined ? ref : existing.activeDeployment,
      latestDeployment: ref,
      account: existing?.account ?? null,
      createdAt: existing?.createdAt ?? now,
    };
    try {
      await this.#store.addDeployment({ agent, deployment, code });
    } catch (error) {
      return refuse(error instanceof Error ? error : new Error(String(error)));
    }
    this.#agents.set(agentId, agent);
    this.#deployments.set(id, Promise.resolve(deployment));
    this.#loaded.set(id, Promise.resolve());
    return {
      agent,
      deployment,
      created: true,
      missingSecrets: await missing(agentId, definition),
    };
  }

  /**
   * Makes a version of an agent its active deployment: what a new actor is created on, and
   * what the actors that follow it move to as their next turns start. It is how a deploy is
   * taken back.
   */
  async activate(id: AgentId, version: number): Promise<Agent> {
    if (this.#closing) throw new Unavailable();
    const agent = await this.#store.setActive(id, version);
    if (agent === undefined) {
      throw (await this.#store.loadAgent(id)) === undefined
        ? new AgentNotFound(id)
        : new AgentNotFound(id, version);
    }
    this.#agents.set(id, agent);
    return agent;
  }

  /** An agent was changed by something beside the engine: it is read again when next wanted. */
  forgetAgent(id: AgentId): void {
    this.#agents.delete(id);
  }

  async getAgent(id: AgentId): Promise<Agent> {
    const agent = await this.#agent(id);
    if (agent === undefined) throw new AgentNotFound(id);
    return agent;
  }

  /** The agent of a name, if there is one. */
  findAgent(name: string): Promise<Agent | undefined> {
    return this.#store.findAgent(name);
  }

  /** Agents, newest first. */
  listAgents(page?: PageOf): Promise<Paged<Agent>> {
    return this.#store.listAgents(page);
  }

  /** An agent's deployments, newest first. */
  async listDeployments(agent: AgentId, page?: PageOf): Promise<Paged<Deployment>> {
    await this.getAgent(agent);
    return this.#store.listDeployments(agent, page);
  }

  /**
   * Deletes an agent, with its deployments, its secrets and its actors. An actor of it that is
   * in a turn has the turn ended first. Its name is free again.
   */
  async deleteAgent(id: AgentId): Promise<void> {
    if (this.#closing) throw new Unavailable();
    await this.getAgent(id);
    // Nothing of the agent's goes on while it is taken away: what its actors are in is ended.
    const hot = [...this.#drivers.values()].filter((driver) => driver.record.actor.agent === id);
    await Promise.all(hot.map((driver) => driver.interrupt().catch(() => {})));
    const gone = await this.#store.deleteAgent(id);
    this.#agents.delete(id);
    if (gone === undefined) return;
    for (const actor of gone.actors) {
      const driver = this.#drivers.get(actor);
      if (driver === undefined) continue;
      // Whatever it would store now has nowhere to go.
      driver.dead = true;
      driver.abandon(new ActorNotFound(actor));
      this.#drivers.delete(actor);
    }
    for (const deployment of gone.deployments) {
      this.#deployments.delete(deployment);
      this.#loaded.delete(deployment);
      await this.#executor.unload(deployment);
    }
    // What its actors had running is stopped where it runs. Nothing is told of it.
    for (const actor of gone.actors) this.tasks.forget(actor);
    // What only its actors' conversations referred to goes with them.
    if (gone.actors.length > 0) await this.blobs.collect();
  }

  /** A deployment, with what its code said of itself. */
  async getDeployment(id: DeploymentId): Promise<Deployment> {
    return this.#deployment(id);
  }

  /**
   * Creates an actor of an agent. It is created on the agent's active deployment, which it
   * then follows, or on the version given, which it is then pinned to. Its configuration is
   * checked by that deployment's schema, and the actor is not made when it fails. With an
   * external ID an actor of the agent has already, that actor is given back and none is made.
   */
  async createActor(given: {
    readonly agent: AgentId;
    readonly version?: number;
    /** Without it, the default model of the agent's provider. */
    readonly modelId?: string;
    readonly reasoning?: Reasoning;
    readonly configuration?: Json;
    readonly name?: Name;
    readonly externalId?: ExternalId;
  }): Promise<{ readonly actor: Actor; readonly created: boolean }> {
    if (this.#closing) throw new Unavailable();
    const agent = await this.getAgent(given.agent);
    if (given.externalId !== undefined) {
      // Asked for again: nothing of the agent's is run, and nothing is checked.
      const there = await this.#store.findActor(agent.id, given.externalId);
      if (there !== undefined) return { actor: there.actor, created: false };
    }

    let deployment = agent.activeDeployment;
    if (given.version !== undefined) {
      const found = await this.#store.findDeployment(agent.id, given.version);
      if (found === undefined) throw new AgentNotFound(agent.id, given.version);
      deployment = { id: found.id, version: found.version };
    }
    const definition = await this.#definition(deployment.id);
    const now = this.#clock();
    const actor: Actor = {
      id: this.#ids.make('actor', now),
      name: given.name ?? null,
      externalId: given.externalId ?? null,
      agent: agent.id,
      deployment,
      pinned: given.version !== undefined,
      behind: null,
      modelId:
        given.modelId ??
        (this.#providers.has(definition.provider)
          ? this.#providers.get(definition.provider).defaultModel
          : ''),
      reasoning: given.reasoning ?? 'medium',
      configuration: null,
      status: 'idle',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: now,
      archivedAt: null,
    };
    if (actor.modelId === '') {
      throw new UnsupportedFeature(
        `The agent is of the provider ${definition.provider}, which this engine has not`,
      );
    }

    const configurationGiven = given.configuration ?? null;
    let configuration: Json | null = null;
    if (definition.configuration !== null || configurationGiven !== null) {
      const checked = await this.#timed(
        deployment.id,
        'configuration.validate',
        configurationGiven,
        contextOf(actor),
        new AbortController().signal,
      );
      if (!checked.ok) {
        if (checked.kind === 'lost') throw new CodeUnavailable(checked.reason);
        throw checked.kind === 'invalid'
          ? new InvalidConfiguration(
              `The configuration is not one of the agent. ${issuesText(checked.issues)}`,
              checked.issues,
            )
          : new InvalidConfiguration(checked.error.message);
      }
      configuration = checked.value;
    }
    const { record, created } = await this.#store.createActor(
      { ...actor, configuration },
      configurationGiven,
    );
    return { actor: record.actor, created };
  }

  /**
   * Changes what an actor was created with: its name, its model, its reasoning, its
   * configuration, and the version of its agent it is on. Only between turns. A version pins
   * it there, and `active` has it follow its agent's active deployment again. Its
   * configuration is checked by the schema of the version it ends up on, and nothing is
   * changed when that fails.
   */
  async updateActor(id: ActorId, changes: ActorUpdate): Promise<Actor> {
    if (this.#closing) throw new Unavailable();
    return (await this.#driver(id)).update(changes);
  }

  async getActor(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).record.actor;
  }

  /** Actors, newest first, as they stand. */
  listActors(query?: ActorsQuery): Promise<Paged<Actor>> {
    return this.#store.listActors(query);
  }

  /** What an actor was sent, newest first. */
  async listInputs(
    actor: ActorId,
    query?: PageOf & { readonly pending?: boolean },
  ): Promise<Paged<Input>> {
    await this.getActor(actor);
    return this.#store.listInputs(actor, query);
  }

  /** A part of an actor's conversation. */
  async conversation(
    actor: ActorId,
    part?: Parameters<Store['conversation']>[1],
  ): Promise<ConversationEntry[]> {
    await this.getActor(actor);
    return this.#store.conversation(actor, part);
  }

  /**
   * What the calls of models add up to: all of them, or those a filter leaves, and by a group
   * as well when one is asked for. It stays when what it was used by is gone.
   */
  usage(filter?: UsageFilter, by?: UsageGroup): Promise<UsageReport> {
    return this.#store.usage(filter, by);
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
    let content: ContentPart[];
    if (definition.inputs.some((declared) => declared.type === sent.type)) {
      // The agent's own code turns what was sent into what the model reads.
      const handled = await this.#timed(
        actor.deployment.id,
        `inputs.${sent.type}.handler`,
        sent.payload ?? null,
        contextOf(actor),
        new AbortController().signal,
      );
      if (!handled.ok) {
        if (handled.kind === 'lost') throw new CodeUnavailable(handled.reason);
        if (handled.kind === 'error') throw new InvalidInput(handled.error.message);
        throw new InvalidInput(
          `The input is not what ${sent.type} takes. ${issuesText(handled.issues)}`,
          handled.issues,
        );
      }
      // An image or file the agent's code made of what was sent is kept apart from the message.
      content = await this.blobs.keep(actorId, contentOf(handled.value));
    } else if (sent.type === 'message') {
      // Every agent takes a message of text, unless it has a `message` of its own.
      content = [{ type: 'text', text: plainMessage(sent.payload ?? null) }];
    } else {
      throw new UnknownInput(sent.type);
    }

    const now = this.#clock();
    const input: Input = {
      id: this.#ids.make('input', now),
      actor: actorId,
      type: sent.type,
      externalId: sent.externalId ?? null,
      message: { role: 'user', content },
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

  /**
   * Stops everything an actor is doing: its turn, and every task it has running. It is left
   * at rest, and whole: what waited in its mailbox, and the endings of what was stopped, start
   * no turn, and are in their place when something new does. Resolves once all of it has
   * stopped.
   */
  async abort(id: ActorId): Promise<AbortResponse> {
    const driver = await this.#driver(id);
    const interrupted = driver.record.turn.phase !== 'idle';
    await driver.hush();
    await driver.interrupt('the turn was aborted by a person, and it is being stopped');
    const tasks = await this.tasks.stopAll(id);
    return { actor: (await this.#driver(id)).record.actor, interrupted, tasks };
  }

  /** Has an actor whose last turn failed try it again, with nothing new. */
  async retry(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).retry();
  }

  /** Puts an actor away: it takes no input until it is unarchived. A turn it is in is ended. */
  async archive(id: ActorId): Promise<Actor> {
    const actor = await (await this.#driver(id)).archive();
    // What it had running is stopped with it. Their endings start no turn.
    await this.tasks.stopAll(id);
    return actor;
  }

  async unarchive(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).unarchive();
  }

  /**
   * Picks up every actor with something owed: what a process does when it starts. It returns
   * how many there were. They go on as turns come free, not all at once.
   */
  async recover(): Promise<number> {
    // The tasks that were under way are watched again, before any call that waits for one.
    await this.tasks.recover();
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
    // A call that waits for a task waits no longer: the task goes on, and the call stays owed.
    this.tasks.closing();
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
    await this.tasks.close();
  }

  /** An agent, as it was last read or written here. */
  async #agent(id: AgentId): Promise<Agent | undefined> {
    const known = this.#agents.get(id);
    if (known !== undefined) return known;
    const read = await this.#store.loadAgent(id);
    // One that was written while this was read is the newer.
    if (read !== undefined && !this.#agents.has(id)) this.#agents.set(id, read);
    return this.#agents.get(id);
  }

  #deployment(id: DeploymentId): Promise<Deployment> {
    let deployment = this.#deployments.get(id);
    if (deployment === undefined) {
      deployment = this.#store.loadDeployment(id).then((stored) => {
        if (stored === undefined) throw new Error(`There is no deployment ${id}`);
        return stored.deployment;
      });
      this.#deployments.set(id, deployment);
      // One that could not be read is asked for again the next time.
      deployment.catch(() => this.#deployments.delete(id));
    }
    return deployment;
  }

  /** What a deployment's code said of itself when it was deployed. */
  async #definition(id: DeploymentId): Promise<AgentDefinition> {
    return (await this.#deployment(id)).definition;
  }

  /** Gives the executor a deployment's code, once: a process that starts has none of it. */
  #ready(id: DeploymentId): Promise<void> {
    let loaded = this.#loaded.get(id);
    if (loaded === undefined) {
      loaded = (async () => {
        const stored = await this.#store.loadDeployment(id);
        if (stored === undefined) throw new Error(`There is no deployment ${id}`);
        const agent = await this.#agent(stored.deployment.agent);
        await this.#executor.load(id, {
          code: stored.code,
          agent: { id: stored.deployment.agent, name: agent?.name ?? '' },
        });
      })();
      this.#loaded.set(id, loaded);
      loaded.catch(() => this.#loaded.delete(id));
    }
    return loaded;
  }

  /** Calls a function of a deployment's code. Code that does not load fails the call. */
  async #call(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult> {
    try {
      await this.#ready(deployment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: 'error', error: { name: 'Error', message } };
    }
    return this.#executor.call(deployment, path, argument, context, signal);
  }

  /** A call that is given up, and fails, when it takes longer than code that is no tool may. */
  async #timed(
    deployment: DeploymentId,
    path: string,
    argument: Json,
    context: CallContext,
    signal: AbortSignal,
  ): Promise<CallResult> {
    const limit = new AbortController();
    const timer = setTimeout(() => {
      limit.abort();
    }, this.#codeTimeoutMs);
    try {
      const both = AbortSignal.any([signal, limit.signal]);
      const result = await this.#call(deployment, path, argument, context, both);
      if (!limit.signal.aborted || signal.aborted) return result;
      const seconds = String(this.#codeTimeoutMs / 1000);
      const message = `${path} did not return within ${seconds} s, and was given up`;
      return { ok: false, kind: 'error', error: { name: 'TimeoutError', message } };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What names the instructions and tools the model is sent for a definition: the same for
   * the same ones, and another when anything of them differs.
   */
  #fingerprint(definition: AgentDefinition, own: readonly EngineTool[]): string {
    const base = this.#fingerprintOf(definition);
    // With the engine's own tools the actor is offered: a model is sent those too.
    if (own.length === 0) return base;
    return createHash('sha256')
      .update(base)
      .update(
        JSON.stringify(
          own.map(({ name, description, parameters }) => [name, description, parameters]),
        ),
      )
      .digest('hex')
      .slice(0, 32);
  }

  #fingerprintOf(definition: AgentDefinition): string {
    let fingerprint = this.#fingerprints.get(definition);
    if (fingerprint === undefined) {
      const tools = definition.tools.map(({ name, description, parameters }) => [
        name,
        description,
        parameters,
      ]);
      const sent = JSON.stringify([
        definition.instructions,
        tools,
        definition.providerOptions ?? null,
      ]);
      fingerprint = createHash('sha256').update(sent).digest('hex').slice(0, 32);
      this.#fingerprints.set(definition, fingerprint);
    }
    return fingerprint;
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
