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
  ActorMachineRequest,
  Agent,
  AgentDefinition,
  AgentId,
  BundleManifest,
  CallIssue,
  CompactResponse,
  Compaction,
  ContentPart,
  ConversationEntry,
  Deployment,
  DeploymentId,
  DeploymentRef,
  ExternalId,
  Input,
  InputId,
  Json,
  MachineEnv,
  MachineId,
  Name,
  PrincipalRef,
  Reasoning,
  SystemMessage,
  UsageGroup,
  UsageReport,
  UserMessage,
} from '@acentric/protocol';

import type { Access } from './accounts.ts';
import { bashKind } from './bash.ts';
import { codeKind } from './code.ts';
import { Blobs } from './blobs.ts';
import { NOTICE, Tasks } from './tasks.ts';
import type { EngineTool, TaskKind, TaskTimes } from './tasks.ts';
import type { BlobStore } from './blobs.ts';
import { MemoryBus } from './bus.ts';
import type { EventBus } from './bus.ts';
import { ActorDriver, contentOf, machineRuleUnmet, offeredTools } from './driver.ts';
import type { ActorUpdate, Clock, Host, Timer } from './driver.ts';
import {
  ActorArchived,
  ActorBusy,
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
import { NO_MACHINE, contextOf, issuesText } from './executor.ts';
import { compactionNumbers } from './compaction.ts';
import { familyOf } from './families.ts';
import type { CallContext, CallHost, CallResult, Executor } from './executor.ts';
import { Semaphore } from './limits.ts';
import { IdSource } from './ids.ts';
import { DEFAULT_RULES } from './machine.ts';
import type { Rules } from './machine.ts';
import { InvalidMachine, Machines, OWN } from './machines.ts';
import type { MachineTimes, MachinesOptions } from './machines.ts';
import type { SandboxProvider } from './sandbox.ts';
import { scheduleKind } from './schedule.ts';
import { AGENT_MESSAGE, subagentTools } from './subagents.ts';
import type { Fired } from './schedule.ts';
import { Sandboxes } from './sandboxes.ts';
import type { SandboxTimes } from './sandboxes.ts';
import { instructionsOf } from './scaffold.ts';
import { SecretsUnavailable } from './secrets.ts';
import type { Secrets } from './secrets.ts';
import type { ActorsQuery, PageOf, Paged, Stopping, Store } from './store.ts';
import type { StoredCompaction } from './state.ts';
import type { UsageFilter } from './usage.ts';
import { viewImage } from './view-image.ts';

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
  /**
   * Has the engine keep machines: computers its actors' commands run on (see `machines.ts`).
   * With it an agent may say `machine: true`, and its actors' models have `bash`. Without it
   * the engine has none, and such an agent is refused when it is deployed.
   */
  readonly machines?: {
    readonly times?: Partial<MachineTimes>;
    /** The daemon this engine hands out for a system, by the SHA-256 of its program. */
    readonly build?: MachinesOptions['build'];
    /** How long a command has to end once it was told to stop. For tests. */
    readonly stopGraceMs?: number;
  };
  /**
   * Has the engine make machines at providers: sandboxes (see `sandboxes.ts`). Only an engine
   * that keeps machines makes any.
   */
  readonly sandboxes?: {
    readonly providers: readonly SandboxProvider[];
    /** Where a sandbox's daemon reaches this engine, when it is not where a request came to. */
    readonly publicUrl?: string;
    readonly times?: Partial<SandboxTimes>;
  };
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

/** A compaction as the API shows it: without what the model is sent in place of the older part. */
function shown({ replacement: _left, ...compaction }: StoredCompaction): Compaction {
  return compaction;
}

/** What stopping an actor stopped, as the model that asked for it is told. */
function whatStopped(stopped: AbortResponse): string {
  const parts = [
    ...(stopped.interrupted ? ['its turn was interrupted'] : []),
    ...(stopped.tasks.length > 0
      ? [
          `${String(stopped.tasks.length)} of its tasks ${stopped.tasks.length === 1 ? 'was' : 'were'} stopped (${stopped.tasks
            .map((task) => task.id)
            .join(', ')})`,
        ]
      : []),
    ...(stopped.agents.length > 0
      ? [`its own subagents were stopped too (${stopped.agents.join(', ')})`]
      : []),
  ];
  return parts.length === 0
    ? 'it was doing nothing. It is idle, and can be sent more.'
    : `${parts.join(', ')}. It is idle, and can be sent more.`;
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
  /** The machines commands run on. Undefined for an engine that keeps none. */
  readonly machines: Machines | undefined;
  /** Undefined for an engine that keeps no machines. */
  readonly sandboxes: Sandboxes | undefined;
  readonly #slots: Semaphore;
  readonly #maxHot: number;
  /** The drivers, the one touched longest ago first. */
  readonly #drivers = new Map<ActorId, ActorDriver>();
  /** The actors that are being stopped: no turn of theirs starts until they have been. */
  readonly #stopping = new Set<ActorId>();
  readonly #report: (error: unknown) => void;
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
    this.#secrets = options.secrets;
    this.#codeTimeoutMs = options.codeTimeoutMs ?? 30_000;
    const { runner } = options;
    const report =
      options.report ??
      ((error: unknown) => {
        console.error(error);
      });
    this.#report = report;
    const kept = options.machines;
    this.machines =
      kept === undefined
        ? undefined
        : new Machines({
            store: options.store,
            id: (now) => this.#ids.make('machine', now),
            clock: this.#clock,
            report,
            envOf: (actor) => this.#envOf(actor),
            ...(kept.times === undefined ? {} : { times: kept.times }),
            ...(kept.build === undefined ? {} : { build: kept.build }),
          });
    this.sandboxes =
      this.machines === undefined
        ? undefined
        : new Sandboxes({
            store: options.store,
            machines: this.machines,
            providers: options.sandboxes?.providers ?? [],
            id: (now) => this.#ids.make('sandboxProvider', now),
            clock: this.#clock,
            report,
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
            ...(options.sandboxes?.publicUrl === undefined
              ? {}
              : { publicUrl: options.sandboxes.publicUrl }),
            ...(options.sandboxes?.times === undefined ? {} : { times: options.sandboxes.times }),
          });
    // Before anything is asked of a machine: one that is a sandbox, and sleeps, is started again.
    const wake = async (machine: MachineId): Promise<void> => this.sandboxes?.wake(machine);
    // An engine that keeps machines has what an agent that works on one uses.
    this.#features = [
      ...(options.features ?? []),
      'schedule',
      'subagents',
      'compaction-settings',
      'codemode',
      ...(this.machines === undefined ? [] : ['machine']),
    ];
    // Every actor's model can send its later self a note.
    const schedule = scheduleKind({
      clock: this.#clock,
      handle: (actor, fired) => this.#scheduleNotice(actor, fired),
    });
    const bash =
      this.machines === undefined
        ? []
        : [
            bashKind(this.machines, {
              wake,
              ...(kept?.stopGraceMs === undefined ? {} : { stopGraceMs: kept.stopGraceMs }),
            }),
          ];
    // A model whose agent has tools for scripts writes scripts that call them.
    const code = codeKind({
      store: options.store,
      clock: this.#clock,
      report,
      actorOf: async (actor) => (await this.#store.loadActor(actor))?.actor,
      definitionOf: (actor) => this.#definition(actor.deployment.id),
      // A tool takes as long as it takes.
      call: (actor, path, argument, signal) =>
        this.#call(actor.deployment.id, path, argument, contextOf(actor), signal),
    });
    // An actor spawns others of the agents its own lists, and talks with them by messages.
    const subagents = subagentTools({
      child: (parent, name) => this.#store.findChild(parent, name),
      children: (parent) => this.#store.listChildren(parent),
      agentNamed: async (name) => {
        const agent = await this.#store.findAgent(name);
        return agent === undefined
          ? undefined
          : { id: agent.id, definition: await this.#definition(agent.activeDeployment.id) };
      },
      // What a subagent is created with takes as long as its agent's code takes.
      call: (actor, path, argument) =>
        this.#call(
          actor.deployment.id,
          path,
          argument,
          contextOf(actor),
          new AbortController().signal,
        ),
      envOf: (actor) => this.#envOf(actor),
      create: async (given) => (await this.createActor(given)).actor,
      post: (to, mail) => this.#post(to, mail),
    });
    // What the engine itself offers a model that answers at once: an image from its machine,
    // and its subagents.
    const ownTools = [
      ...subagents,
      ...(this.machines === undefined
        ? []
        : [
            viewImage(
              this.machines,
              (provider, model) =>
                this.#providers.has(provider) &&
                this.#providers
                  .get(provider)
                  .models.find((info) => info.id === model)
                  ?.input?.includes('image') === true,
              wake,
            ),
          ]),
    ];
    this.tasks = new Tasks({
      store: options.store,
      clock: this.#clock,
      inputId: (now) => this.#ids.make('input', now),
      keep: (actor, content) => this.blobs.keep(actor, content),
      report,
      kinds: [...bash, code, schedule, ...(options.kinds ?? [])],
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
    // `stop` with the name of a subagent stops it, as the actor that spawned it.
    this.tasks.onStopAgent(async (actor, name) => {
      const child = await this.#store.findChild(actor, name);
      if (child === undefined) return undefined;
      const stopped = await this.abort(child.actor.id, 'parent');
      return { text: `stopped ${name}: ${whatStopped(stopped)}` };
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
      ownTools: (actor, definition) => ownTools.filter((one) => one.available(actor, definition)),
      stopping: (actor) => this.#stopping.has(actor),
      compaction: (actor, definition) => {
        const provider = this.#providers.has(definition.provider)
          ? this.#providers.get(definition.provider)
          : undefined;
        const model = provider?.models.find((info) => info.id === actor.modelId);
        // A size from which every token costs more, where the model's calls are paid by the token.
        const dearerAbove =
          provider?.plan === true ? undefined : model?.pricing?.tiers?.[0]?.aboveInputTokens;
        return {
          ...compactionNumbers(definition.compactionSettings?.[actor.modelId], {
            ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(dearerAbove === undefined ? {} : { dearerAbove }),
          }),
          compacts: provider?.compacts,
          reader: {
            read: (message) =>
              provider === undefined ? { text: '', toolCalls: [] } : provider.read(message),
            compacted: (message) => provider?.compacted?.(message),
          },
        };
      },
      stillGoingOn: async (actor) => {
        const tasks = await this.tasks.describe(actor);
        const agents = (await this.#store.listChildren(actor)).map(
          (child) => `- ${child.parent?.name ?? child.id} · ${child.status}`,
        );
        if (tasks.length === 0 && agents.length === 0) return '<compacted/>';
        return [
          '<compacted>',
          ...(tasks.length === 0 ? [] : ['Tasks running:', ...tasks.map((line) => `- ${line}`)]),
          ...(agents.length === 0 ? [] : ['Subagents:', ...agents]),
          '</compacted>',
        ].join('\n');
      },
      instructions: (actor, definition, own) => {
        const { machine } = actor;
        const facts = machine === null ? undefined : this.machines?.facts(machine.id);
        const family = familyOf(actor.modelId);
        return instructionsOf(
          {
            tools: own.map((tool) => tool.name),
            machine:
              machine === null
                ? null
                : { cwd: machine.cwd, os: facts?.os ?? null, arch: facts?.arch ?? null },
            ...(family === undefined ? {} : { family }),
            ...(actor.parent === null ? {} : { spawned: true }),
          },
          definition.instructions,
        );
      },
      fingerprint: (definition, own, instructions) =>
        this.#fingerprint(definition, own, instructions),
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
    /** The machine it works on, for an actor of an agent that says `machine: true`. */
    readonly machine?: ActorMachineRequest;
    /**
     * For a subagent: the actor that spawns it, the name that actor gives it, and the call of
     * its model that does. It is the engine's own to say: no request from outside gives it.
     */
    readonly parent?: { readonly id: ActorId; readonly name: string; readonly call: string };
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
    const unmet = machineRuleUnmet(definition, given.machine !== undefined);
    if (unmet !== undefined) throw new InvalidMachine(unmet);
    if (given.machine !== undefined) {
      // Whoever creates it: the machine says for which agents it is.
      const refused = await this.machines?.refuses(given.machine.id, agent.id);
      if (refused !== undefined) throw new InvalidMachine(refused);
    }
    const now = this.#clock();
    const env = given.machine?.env ?? {};
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
      machine:
        given.machine === undefined
          ? null
          : { id: given.machine.id, cwd: given.machine.cwd, env: Object.keys(env).toSorted() },
      parent: given.parent === undefined ? null : { id: given.parent.id, name: given.parent.name },
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
    // Sealed before anything is stored: an engine that keeps no secrets takes none of these.
    const sealed = this.#sealEnv(actor.id, env);
    const { record, created } = await this.#store.createActor(
      { ...actor, configuration },
      configurationGiven,
      sealed,
      given.parent?.call ?? null,
    );
    return { actor: record.actor, created };
  }

  /**
   * Gives an actor the variables its commands are run with on its machine, in place of all it
   * had. They are kept sealed, and are changed at any time: the next command has them.
   */
  async setEnv(id: ActorId, env: MachineEnv): Promise<Actor> {
    if (this.#closing) throw new Unavailable();
    const driver = await this.#driver(id);
    if (driver.record.actor.machine === null) {
      throw new InvalidMachine(
        `The actor ${id} has no machine, so it runs no command to give variables to`,
      );
    }
    const names = Object.keys(env).toSorted();
    await this.#store.setActorEnv(id, names, this.#sealEnv(id, env));
    // The driver may have been given up meanwhile: the one there is now reads what was stored.
    return (await this.#driver(id)).envNamed(names);
  }

  /** What an actor's variables are sealed as: they open as no other actor's. */
  static #bound(actor: string): string {
    return `actor:${actor}:env`;
  }

  /** An actor's variables, sealed. Null for none. */
  #sealEnv(actor: ActorId, env: MachineEnv): string | null {
    if (Object.keys(env).length === 0) return null;
    if (this.#secrets === undefined) throw new SecretsUnavailable();
    return this.#secrets.seal(Engine.#bound(actor), JSON.stringify(env));
  }

  /** The variables an actor's commands are run with, opened. None for a machine's own commands. */
  async #envOf(actor: string): Promise<MachineEnv> {
    if (actor === OWN) return {};
    const sealed = await this.#store.actorEnv(actor as ActorId);
    if (sealed === null) return {};
    if (this.#secrets === undefined) throw new SecretsUnavailable();
    const opened = this.#secrets.open(
      Engine.#bound(actor),
      sealed,
      `The variables of the actor ${actor}`,
    );
    return JSON.parse(opened) as MachineEnv;
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

  /**
   * Puts a message of another actor's in an actor's mailbox, once for one `id`: its parent's,
   * which is a message as a person's is, or a subagent's, which is a notice. Rejects for an
   * actor that is archived, or is no more.
   */
  async #post(
    to: ActorId,
    mail: { readonly id: string; readonly message: UserMessage | SystemMessage },
  ): Promise<void> {
    const driver = await this.#driver(to);
    if (driver.record.actor.status === 'archived') throw new ActorArchived(to);
    if ((await this.#store.findInput(to, mail.id)) !== undefined) return;
    const now = this.#clock();
    const input: Input = {
      id: this.#ids.make('input', now),
      actor: to,
      type: mail.message.role === 'user' ? AGENT_MESSAGE : NOTICE,
      externalId: mail.id as ExternalId,
      message: mail.message,
      receivedAt: now,
      deliveredAt: null,
    };
    // Said twice at once, the other got there first.
    if ((await this.#store.addInput(input)) === 'duplicate') return;
    (await this.#driver(to)).receive(input);
  }

  /**
   * An actor and the actors above it: the one that spawned it, the one that spawned that, and
   * so on to one that was created from outside.
   */
  async lineage(id: ActorId): Promise<Actor[]> {
    const line = [await this.getActor(id)];
    for (let above = line[0]?.parent; above !== null && above !== undefined;) {
      const parent = (await this.#store.loadActor(above.id))?.actor;
      if (parent === undefined) break;
      line.push(parent);
      above = parent.parent;
    }
    return line;
  }

  /** The subagents of an actor, in the order it spawned them. */
  async children(id: ActorId): Promise<Actor[]> {
    await this.getActor(id);
    return this.#store.listChildren(id);
  }

  /** Ends the turn an actor is in. What waits in its mailbox stays, and starts the next. */
  async interrupt(id: ActorId): Promise<Actor> {
    const driver = await this.#driver(id);
    const working = driver.record.turn.phase !== 'idle';
    const actor = await driver.interrupt();
    // The actor that spawned it waits on it, and is told what was done to it from outside.
    if (working) await this.#tellParent(actor, 'interrupted', 'person');
    return actor;
  }

  /**
   * Stops everything an actor is doing: its turn, and every task it has running. It is left
   * at rest, and whole: what waited in its mailbox, and the endings of what was stopped, start
   * no turn, and are in their place when something new does. Resolves once all of it has
   * stopped.
   */
  async abort(id: ActorId, by: Stopping['by'] = 'person'): Promise<AbortResponse> {
    return this.#stop(id, { how: 'abort', by });
  }

  /**
   * Stops an actor and, each in the same way, the actors it spawned and theirs. It is written
   * down first that it is being stopped, so that an engine that goes away in the middle is
   * gone on from by the next. No turn of the actor starts until it has been stopped.
   */
  async #stop(id: ActorId, stopping: Stopping): Promise<AbortResponse> {
    const { how, by } = stopping;
    const driver = await this.#driver(id);
    const before = driver.record.actor;
    const interrupted = driver.record.turn.phase !== 'idle';
    this.#stopping.add(id);
    try {
      await this.#store.setStopping(id, stopping);
      // What waited starts no turn: it is there for the next one that something new starts.
      await driver.hush();
      const who = by === 'parent' ? 'the agent that created it' : 'a person';
      const why = `the turn was aborted by ${who}, and it is being stopped`;
      if (how === 'archive' && before.status !== 'archived') await driver.archive(why);
      else await driver.interrupt(why);
      const tasks = await this.tasks.stopAll(id);
      const agents: string[] = [];
      for (const child of await this.#store.listChildren(id)) {
        // The engine is going away: the next one finds it written down, and goes on.
        if (this.#closing) break;
        await this.#stop(child.id, { how, by: 'parent' });
        if (child.parent !== null) agents.push(child.parent.name);
      }
      const now = await this.#driver(id);
      if (this.#closing) return { actor: now.record.actor, interrupted, tasks, agents };
      // What their stopping said is not what starts the next turn either.
      await now.hush([NOTICE]);
      await this.#store.setStopping(id, null);
      const stopped = interrupted || tasks.length > 0 || agents.length > 0;
      if (stopped || (how === 'archive' && before.status !== 'archived')) {
        await this.#tellParent(before, how === 'archive' ? 'archived' : 'aborted', by);
      }
      return { actor: now.record.actor, interrupted, tasks, agents };
    } finally {
      this.#stopping.delete(id);
      // Something a person sent while it was being stopped is new: it starts a turn.
      if (!this.#closing) this.#drivers.get(id)?.wake();
    }
  }

  /**
   * Tells the actor that spawned this one what was done to it from outside. It may wait on
   * this one, and would otherwise wait for ever. Not when it was the parent itself that did it.
   */
  async #tellParent(
    actor: Actor,
    how: 'interrupted' | 'aborted' | 'archived',
    by: Stopping['by'],
  ): Promise<void> {
    if (by !== 'person' || actor.parent === null) return;
    const { id: parent, name } = actor.parent;
    const message: SystemMessage = {
      role: 'system',
      content: [{ type: 'text', text: `<agent name="${name}" status="${how}" by="person"/>` }],
      metadata: { agent: { from: actor.id, name, status: how } },
    };
    try {
      await this.#post(parent, {
        id: `told:${actor.id}:${String(this.#ids.make('input', this.#clock()))}`,
        message,
      });
    } catch (error) {
      // A parent that is archived, or gone, is told nothing.
      if (!(error instanceof ActorArchived) && !(error instanceof ActorNotFound)) throw error;
    }
  }

  /**
   * Compacts an actor's conversation now, whatever its size, for a person who asks. Between
   * turns only. `compacted` is null when there was nothing to compact.
   */
  async compact(id: ActorId): Promise<CompactResponse> {
    if (this.#closing) throw new Unavailable();
    const driver = await this.#driver(id);
    const { actor, turn } = driver.record;
    if (actor.status === 'archived') throw new ActorArchived(id);
    if (turn.phase !== 'idle' || this.#stopping.has(id)) throw new ActorBusy(id);
    const made = await driver.compact();
    return {
      actor: (await this.#driver(id)).record.actor,
      compacted: made === null ? null : shown(made),
    };
  }

  /** The compactions of an actor's conversation, newest first. */
  async compactions(id: ActorId): Promise<Compaction[]> {
    await this.getActor(id);
    return (await this.#store.listCompactions(id)).map(shown);
  }

  /** Has an actor whose last turn failed try it again, with nothing new. */
  async retry(id: ActorId): Promise<Actor> {
    return (await this.#driver(id)).retry();
  }

  /** Puts an actor away: it takes no input until it is unarchived. A turn it is in is ended. */
  async archive(id: ActorId): Promise<Actor> {
    // What it had running is stopped with it, and so are the actors it spawned, and theirs.
    return (await this.#stop(id, { how: 'archive', by: 'person' })).actor;
  }

  /** Takes an actor out again, and the actors it spawned, and theirs. */
  async unarchive(id: ActorId): Promise<Actor> {
    const actor = await (await this.#driver(id)).unarchive();
    for (const child of await this.#store.listChildren(id)) {
      if (child.status === 'archived') await this.unarchive(child.id);
    }
    return actor;
  }

  /**
   * Picks up every actor with something owed: what a process does when it starts. It returns
   * how many there were. They go on as turns come free, not all at once.
   */
  async recover(): Promise<number> {
    // What each machine's daemon last said is known again, before its daemon has found this engine.
    await this.machines?.load();
    // The tasks that were under way are watched again, before any call that waits for one.
    await this.tasks.recover();
    // An actor an engine before this one was stopping is gone on with, down its tree.
    for (const { actor, ...stopping } of await this.#store.listStopping()) {
      this.#stop(actor, stopping).catch((error: unknown) => {
        if (!(error instanceof ActorNotFound) && !this.#closing) this.#report(error);
      });
    }
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
    // The daemons' connections are dropped. The commands on the machines go on.
    this.sandboxes?.close();
    this.machines?.close();
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
    /** Stops and starts the call's time limit, when it has one. */
    limit?: { readonly pause: () => void; readonly resume: () => void },
  ): Promise<CallResult> {
    try {
      await this.#ready(deployment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: 'error', error: { name: 'Error', message } };
    }
    // A schema says what an actor may be created with, before there is one: it has no machine.
    const machine = path === 'configuration.validate' ? null : context.machine;
    let env: MachineEnv = {};
    try {
      // The code is given the variables too, as they are now.
      if (machine !== null) env = await this.#envOf(context.actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: 'error', error: { name: 'Error', message } };
    }
    const { machines } = this;
    const host: CallHost =
      machine === null || machines === undefined
        ? NO_MACHINE
        : {
            file: async (request) => {
              // Having its machine there is the engine's time, not the code's: the call's
              // limit waits for it. A sandbox that sleeps is woken, and a machine on its way
              // back is waited for.
              limit?.pause();
              try {
                await this.sandboxes?.wake(machine.id);
                await machines.settled(machine.id, signal);
              } finally {
                limit?.resume();
              }
              return machines.file(machine, request);
            },
          };
    return this.#executor.call(
      deployment,
      path,
      argument,
      {
        ...context,
        machine:
          machine === null
            ? null
            : {
                id: machine.id,
                cwd: machine.cwd,
                ...(Object.keys(env).length === 0 ? {} : { env }),
              },
      },
      signal,
      host,
    );
  }

  /**
   * What the notice of a fired schedule says, by the handler of the version the actor is on:
   * undefined when that version has none. Throws when the handler fails or is cut off.
   */
  async #scheduleNotice(id: ActorId, fired: Fired): Promise<string | undefined> {
    const actor = await this.getActor(id);
    const definition = await this.#definition(actor.deployment.id);
    if (definition.features?.includes('schedule') !== true) return undefined;
    const result = await this.#timed(
      actor.deployment.id,
      'schedule.handler',
      fired,
      contextOf(actor),
      new AbortController().signal,
    );
    if (result.ok) {
      if (typeof result.value === 'string') return result.value;
      throw new Error('The schedule handler failed: it returned what is not text');
    }
    if (result.kind === 'lost') {
      throw new Error(`The schedule handler was cut off: ${result.reason}`);
    }
    const said =
      result.kind === 'error' ? result.error.message : 'it was given what it does not take';
    throw new Error(`The schedule handler failed: ${said}`);
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
    // What is left of its time, and since when that runs: it stops while the engine, and not
    // the code, takes the time.
    let left = this.#codeTimeoutMs;
    let since = Date.now();
    let paused = 0;
    const run = (): NodeJS.Timeout =>
      setTimeout(() => {
        limit.abort();
      }, left);
    let timer = run();
    const clock = {
      pause: (): void => {
        paused += 1;
        if (paused !== 1) return;
        clearTimeout(timer);
        left = Math.max(0, left - (Date.now() - since));
      },
      resume: (): void => {
        paused -= 1;
        if (paused !== 0) return;
        since = Date.now();
        timer = run();
      },
    };
    try {
      const both = AbortSignal.any([signal, limit.signal]);
      const result = await this.#call(deployment, path, argument, context, both, clock);
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
  #fingerprint(
    definition: AgentDefinition,
    own: readonly EngineTool[],
    instructions: string,
  ): string {
    const base = this.#fingerprintOf(definition);
    // With the engine's own tools the actor is offered, and what the harness tells it before
    // its agent's instructions: a model is sent those too.
    return createHash('sha256')
      .update(base)
      .update(
        JSON.stringify([
          instructions,
          own.map(({ name, description, parameters }) => [name, description, parameters]),
        ]),
      )
      .digest('hex')
      .slice(0, 32);
  }

  #fingerprintOf(definition: AgentDefinition): string {
    let fingerprint = this.#fingerprints.get(definition);
    if (fingerprint === undefined) {
      const tools = offeredTools(definition).map(({ name, description, parameters }) => [
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
