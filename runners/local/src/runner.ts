// The local runner: runs instances kept in a store, following RUNNERS.md.
//
// Each instance has a mailbox, and its jobs run one at a time: a caller's
// input or config change, an effect's result from the durable inbox, an
// upgrade, recovery. A step's whole result is checked, then committed to the
// store in one write; only after the commit do handlers start or get their
// signal, callers get their answer and subscribers hear of it. Handlers run
// in handler hosts, child processes per bundle. When a handler finishes, its
// outcome is saved to the inbox before its step runs, so a crash in between
// loses nothing.
//
// Instances are loaded when a job needs them and unloaded after a while
// idle. Effects and timers are tracked apart from loaded instances, so an
// instance can be unloaded while its effects run.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  Agent,
  EffectMessage,
  InputMessage,
  Json,
  JsonObject,
  LogAppend,
  LogEntry,
  LogPage,
  LogQuery,
  Message,
  Outcome,
  State,
} from '@acentric/types';

import { HostPool } from './host/pool.js';
import type { HostOutcome } from './host/pool.js';
import { deepFreeze, frozenCopy, isJson, requireJson, thrownToJson } from './json.js';
import { StoreError } from './store/types.js';
import type {
  AgentRef,
  InstanceFilter,
  InstanceSummary,
  KindInfo,
  Store,
  StoredEffect,
} from './store/types.js';
import { Scheduler } from './timers.js';

/** What a caller is told about a create, input, config change or upgrade. */
export type Answer = { accepted: true } | { rejected: Json } | { failed: Json };

export type Status = 'idle' | 'busy' | 'faulted';

export type RunningEffect = {
  key: string;
  kind: string;
  args: Json;
  attempt: number;
  abort: boolean;
  /** Whether a handler is executing it now, as opposed to a timer waiting. */
  active: boolean;
};

export type InstanceInfo = {
  id: string;
  agent: AgentRef;
  status: Status;
  fault: string | null;
  view: Json;
  nextSeq: number;
  running: RunningEffect[];
  /** Whether a job is running or waiting in the instance's mailbox. */
  working: boolean;
};

export type InstanceListing = InstanceSummary & { status: Status };

/** What a subscriber hears about an instance. */
export type InstanceEvent =
  | { type: 'log'; entries: LogEntry[] }
  | { type: 'view'; view: Json }
  | { type: 'status'; status: Status; fault: string | null }
  | { type: 'emit'; key: string; delta: Json };

export type SubscribeOptions = {
  /** Replays entries after this seq first. Defaults to 0: the whole log. */
  after?: number;
  /** Whether to hear what handlers emit. */
  emits?: boolean;
};

/** An agent's code to deploy: two ES modules, the pure half and the handlers. */
export type DeployBundle = AgentRef & { agent: string; handlers: string };

/** The built-in kinds this runner provides, for an agent's map of kinds. */
export type LocalRunnerKinds = {
  /** Fires at `at`, in milliseconds since the Unix epoch, and returns null. */
  '@timer': { args: { at: number }; result: null };
};

export type LocalRunnerOptions = {
  store: Store;
  /** Where deployed code is written to be loaded. Files are named by hash, so runners can share it. */
  codeDir?: string;
  /** Secret values by name, for handlers. */
  secrets?: Record<string, string>;
  /** The clock, in milliseconds since the Unix epoch. Defaults to Date.now. */
  clock?: () => number;
  /** A handler's time limit when it sets none. Defaults to none. */
  timeoutMs?: number;
  /** Runs of one reissue key when its handler sets no limit. Defaults to 5. */
  maxAttempts?: number;
  /** How long close waits for running handlers. Defaults to 5000 ms. */
  graceMs?: number;
  /** How long an instance stays loaded with nothing to do. Defaults to 5 minutes. */
  idleMs?: number;
  host?: {
    /** Node options for handler hosts, such as `--import` of a module to load first. */
    execArgv?: readonly string[];
    /** Environment variables for handler hosts. */
    env?: Record<string, string>;
    /** How long a host with nothing to run stays up. Defaults to 30 s. */
    idleMs?: number;
  };
};

export type RunnerErrorCode =
  | 'closed'
  | 'no_agent'
  | 'no_instance'
  | 'instance_exists'
  | 'bundle_conflict'
  | 'invalid_bundle'
  | 'missing_kinds'
  | 'request_conflict';

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

const RUNNER_KINDS = new Set(['@timer']);
const PAGE_SIZE = 100;

type Code = {
  ref: AgentRef;
  hash: string;
  agent: Agent<JsonObject, JsonObject>;
  kinds: Record<string, KindInfo>;
  handlersPath: string;
};

/** A loaded instance. */
type Live = {
  id: string;
  code: Code;
  config: JsonObject;
  snapshot: JsonObject;
  nextSeq: number;
  fault: string | null;
  /** Log entries from `windowStart` on. */
  entries: LogEntry[];
  windowStart: number;
  /** When the newest entry was written; `now` never goes below it. */
  lastAt: number;
  /** Declared, unfinished effects, in the order they started. */
  effects: Map<string, StoredEffect>;
  view: Json;
  usedAt: number;
};

type Flight = {
  key: string;
  kind: string;
  hash: string;
  done: boolean;
  cancelled: boolean;
  aborted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Whether a handler is executing it, as opposed to a timer waiting. */
  active: boolean;
};

type Reply = { resolve: (answer: Answer) => void; reject: (error: Error) => void };

type Job =
  | ({ type: 'input'; input: InputMessage } & Reply)
  | ({ type: 'configure'; config: JsonObject; requestId: string | null } & Reply)
  | ({ type: 'upgrade'; version: string } & Reply)
  | { type: 'delete'; done: Reply }
  | { type: 'result'; ord: number; key: string; outcome: Outcome }
  | { type: 'recover' };

type Mailbox = { jobs: Job[]; running: Promise<void> | null };

/** A step's result, checked and ready to commit. */
type Prepared = {
  code: Code;
  snapshot: JsonObject;
  config: JsonObject;
  entries: LogEntry[];
  windowStart: number;
  windowEntries: LogEntry[];
  effects: Map<string, StoredEffect>;
  started: StoredEffect[];
  cancelled: string[];
  aborted: string[];
  finished: string[];
  view: Json;
};

type Subscriber = {
  listener: (event: InstanceEvent) => void;
  emits: boolean;
  /** Entries held back while the history is replayed; null once live. */
  held: LogEntry[] | null;
};

export function createLocalRunner(options: LocalRunnerOptions): LocalRunner {
  return new LocalRunner(options);
}

export class LocalRunner {
  readonly #store: Store;
  readonly #codeDir: string;
  readonly #secrets: Record<string, string>;
  readonly #clock: () => number;
  readonly #timeoutMs: number | undefined;
  readonly #maxAttempts: number;
  readonly #graceMs: number;
  readonly #idleMs: number;
  readonly #hosts: HostPool;
  readonly #scheduler: Scheduler;
  readonly #codes = new Map<string, Promise<Code>>();
  readonly #lives = new Map<string, Promise<Live | null>>();
  readonly #mailboxes = new Map<string, Mailbox>();
  readonly #flights = new Map<string, Map<string, Flight>>();
  /** Inbox items already in a mailbox, by instance. */
  readonly #queued = new Map<string, Set<number>>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  readonly #statuses = new Map<string, Status>();
  #unloader: ReturnType<typeof setInterval> | null = null;
  #closing = false;
  #closed = false;

  constructor(options: LocalRunnerOptions) {
    this.#store = options.store;
    this.#codeDir = options.codeDir ?? join(tmpdir(), 'acentric-runner-code');
    this.#secrets = { ...options.secrets };
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#graceMs = options.graceMs ?? 5000;
    this.#idleMs = options.idleMs ?? 5 * 60_000;
    this.#scheduler = new Scheduler(this.#clock);
    this.#hosts = new HostPool({
      ...(options.host?.execArgv === undefined ? {} : { execArgv: options.host.execArgv }),
      ...(options.host?.env === undefined ? {} : { env: options.host.env }),
      idleMs: options.host?.idleMs ?? 30_000,
      secret: (name) => this.#secrets[name],
      readLog: async (instance, query) => {
        const page = await this.log(instance, query);
        return {
          entries: [...page.entries],
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      },
      emitted: (instance, key, delta) => this.#emitted(instance, key, delta),
    });
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Recovers what the store holds, as after a crash: inbox results are
   * stepped, reissue effects that were running run again with the next
   * attempt, once effects that were running are reported interrupted, and
   * timers are scheduled again.
   */
  async start(): Promise<void> {
    this.#open();
    for (const id of await this.#store.pending()) this.#enqueue(id, { type: 'recover' });
    this.#unloader = setInterval(() => this.#unloadIdle(), Math.max(this.#idleMs / 2, 50));
    this.#unloader.unref();
  }

  /**
   * Stops: takes no more requests, finishes the jobs already running, gives
   * running handlers the grace period, then stops the hosts. What still runs
   * stays declared and is recovered by the next start. Does not close the
   * store.
   */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const mailbox of this.#mailboxes.values()) {
      for (const job of mailbox.jobs.splice(0))
        refuse(job, new RunnerError('closed', 'the runner is closing'));
    }
    await Promise.all(
      [...this.#mailboxes.values()].map((mailbox) => mailbox.running ?? Promise.resolve()),
    );
    const deadline = Date.now() + this.#graceMs;
    while (this.#activeFlights() > 0 && Date.now() < deadline) {
      // Waiting on handlers in other processes, a little at a time.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all(
      [...this.#mailboxes.values()].map((mailbox) => mailbox.running ?? Promise.resolve()),
    );
    this.#shutDown();
  }

  /** Stops at once, as a crash would: nothing more is saved. Does not close the store. */
  kill(): void {
    this.#closing = true;
    for (const mailbox of this.#mailboxes.values()) {
      for (const job of mailbox.jobs.splice(0))
        refuse(job, new RunnerError('closed', 'the runner stopped'));
    }
    this.#shutDown();
  }

  #shutDown(): void {
    this.#closed = true;
    this.#hosts.close();
    this.#scheduler.clear();
    if (this.#unloader !== null) clearInterval(this.#unloader);
    for (const flights of this.#flights.values()) {
      for (const flight of flights.values()) if (flight.timer !== null) clearTimeout(flight.timer);
    }
  }

  // ---- agents ---------------------------------------------------------------

  /**
   * Deploys an agent's code under a name and version. The same code again
   * changes nothing; different code under a deployed name and version is
   * refused. The handlers are loaded in a host to read their kinds, and an
   * agent that lists its kinds must have a handler for each.
   */
  async deploy(bundle: DeployBundle): Promise<{ hash: string; deployed: boolean }> {
    this.#open();
    const hash = digest([bundle.name, bundle.version, bundle.agent, bundle.handlers]);
    const existing = await this.#store.getBundle(bundle);
    if (existing !== null) {
      if (existing.hash === hash) return { hash, deployed: false };
      throw new RunnerError(
        'bundle_conflict',
        `different code is already deployed as ${bundle.name}@${bundle.version}`,
      );
    }
    const files = await this.#write(hash, bundle.agent, bundle.handlers);
    let agent: Agent<JsonObject, JsonObject>;
    let kinds: Record<string, KindInfo>;
    try {
      agent = await importAgent(files.agentPath);
      kinds = await this.#hosts.describe(files.handlersPath);
    } catch (error) {
      throw new RunnerError(
        'invalid_bundle',
        error instanceof Error ? error.message : String(error),
      );
    }
    const missing = (agent.kinds ?? []).filter(
      (kind) => !(kind in kinds) && !RUNNER_KINDS.has(kind),
    );
    if (missing.length > 0) {
      throw new RunnerError('missing_kinds', `no handler for ${missing.join(', ')}`);
    }
    try {
      const stored = await this.#store.putBundle({ ...bundle, hash, kinds });
      return { hash, deployed: stored === 'stored' };
    } catch (error) {
      throw error instanceof StoreError && error.code === 'bundle_conflict'
        ? new RunnerError('bundle_conflict', error.message)
        : error;
    }
  }

  listAgents(): Promise<(AgentRef & { hash: string; instances: number })[]> {
    return this.#store.listBundles();
  }

  // ---- instances ------------------------------------------------------------

  /**
   * Creates an instance, running init. With an id, creating the same agent
   * and config again answers as the first time did.
   */
  async create(
    agent: AgentRef,
    config: JsonObject,
    options: { id?: string } = {},
  ): Promise<Answer & { id?: string }> {
    this.#open();
    const code = await this.#code(agent);
    if (!isJson(config)) return { failed: 'the config is not plain Json' };
    const id = options.id ?? randomUUID();
    const creation = digest([agent.name, agent.version, config]);
    if (options.id !== undefined) {
      const existing = await this.#store.load(id);
      if (existing !== null) {
        if (existing.createHash === creation) return { accepted: true, id };
        throw new RunnerError('instance_exists', `instance ${id} already exists`);
      }
    }
    const now = this.#clock();
    let result;
    try {
      result = code.agent.init(frozenCopy(config), now);
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    if ('error' in result) return { rejected: requireJson(result.error, 'the rejection') };
    const live: Live = {
      id,
      code,
      config: frozenCopy(config),
      snapshot: {},
      nextSeq: 1,
      fault: null,
      entries: [],
      windowStart: 1,
      lastAt: 0,
      effects: new Map(),
      view: null,
      usedAt: Date.now(),
    };
    let prepared;
    try {
      prepared = await this.#prepare(
        live,
        code,
        result.snapshot,
        result.append ?? [],
        live.config,
        null,
        now,
      );
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    try {
      await this.#store.create(
        {
          id,
          agent: code.ref,
          config: prepared.config,
          snapshot: prepared.snapshot,
          nextSeq: 1,
          fault: null,
          createHash: creation,
          createdAt: now,
        },
        { append: prepared.entries, started: prepared.started },
      );
    } catch (error) {
      if (error instanceof StoreError && error.code === 'instance_exists') {
        throw new RunnerError('instance_exists', error.message);
      }
      throw error;
    }
    this.#lives.set(id, Promise.resolve(live));
    const viewBefore = JSON.stringify(live.view);
    this.#apply(live, prepared, null);
    this.#act(live, prepared);
    this.#notify(live, prepared, viewBefore);
    return { accepted: true, id };
  }

  /** Sends an input, answering once its step is saved. A retry with the same input id gets the same answer. */
  input(id: string, input: { id?: string; kind: string; payload: JsonObject }): Promise<Answer> {
    const message: InputMessage = {
      type: 'input',
      id: input.id ?? randomUUID(),
      kind: input.kind,
      payload: input.payload,
    };
    return new Promise((resolve, reject) =>
      this.#enqueue(id, { type: 'input', input: message, resolve, reject }),
    );
  }

  /** Changes an instance's config, answering once its step is saved. A request id makes a retry safe. */
  configure(id: string, config: JsonObject, requestId?: string): Promise<Answer> {
    return new Promise((resolve, reject) =>
      this.#enqueue(id, {
        type: 'configure',
        config,
        requestId: requestId ?? null,
        resolve,
        reject,
      }),
    );
  }

  /** Moves an instance onto another deployed version of its agent. Clears a fault. */
  upgrade(id: string, version: string): Promise<Answer> {
    return new Promise((resolve, reject) =>
      this.#enqueue(id, { type: 'upgrade', version, resolve, reject }),
    );
  }

  /** Cancels an instance's effects and removes it from the store. */
  delete(id: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.#enqueue(id, { type: 'delete', done: { resolve: () => resolve(), reject } }),
    );
  }

  async get(id: string): Promise<InstanceInfo> {
    const live = await this.#live(id);
    if (live === null) throw new RunnerError('no_instance', `no instance ${id}`);
    return {
      id,
      agent: live.code.ref,
      status: this.#status(id, live.fault),
      fault: live.fault,
      view: live.view,
      nextSeq: live.nextSeq,
      running: this.#running(live),
      working: this.#working(id),
    };
  }

  async list(filter?: InstanceFilter): Promise<InstanceListing[]> {
    const instances = await this.#store.list(filter);
    return instances.map((instance) =>
      Object.assign(instance, { status: this.#status(instance.id, instance.fault) }),
    );
  }

  /** A page of the log. */
  async log(id: string, query: LogQuery = {}): Promise<LogPage> {
    const after = Math.max(query.after ?? 0, query.cursor === undefined ? 0 : Number(query.cursor));
    const limit = Math.max(1, Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE));
    const entries = await this.#store.readLog(id, {
      after,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
      limit: limit + 1,
    });
    if (entries.length <= limit) return { entries };
    const page = entries.slice(0, limit);
    return { entries: page, cursor: String(page.at(-1)?.seq ?? after) };
  }

  /**
   * Tells `listener` what happens to an instance: first the log after
   * `after`, from the store, then each commit's entries as it is saved, with
   * no gap between the two. Returns a function that stops it.
   */
  async subscribe(
    id: string,
    options: SubscribeOptions,
    listener: (event: InstanceEvent) => void,
  ): Promise<() => void> {
    const live = await this.#live(id);
    if (live === null) throw new RunnerError('no_instance', `no instance ${id}`);
    const subscriber: Subscriber = { listener, emits: options.emits === true, held: [] };
    const subscribers = this.#subscribers.get(id) ?? new Set();
    subscribers.add(subscriber);
    this.#subscribers.set(id, subscribers);
    let last = options.after ?? 0;
    for (;;) {
      // Replaying the history a page at a time.
      // oxlint-disable-next-line no-await-in-loop
      const entries = await this.#store.readLog(id, { after: last, limit: 500 });
      if (entries.length === 0) break;
      listener({ type: 'log', entries });
      last = entries.at(-1)?.seq ?? last;
    }
    const held = (subscriber.held ?? []).filter((entry) => entry.seq > last);
    subscriber.held = null;
    if (held.length > 0) listener({ type: 'log', entries: held });
    listener({ type: 'view', view: live.view });
    listener({ type: 'status', status: this.#status(id, live.fault), fault: live.fault });
    return () => subscribers.delete(subscriber);
  }

  // ---- mailboxes ------------------------------------------------------------

  #enqueue(id: string, job: Job): void {
    if (this.#closing) {
      refuse(job, new RunnerError('closed', 'the runner is closed'));
      return;
    }
    const mailbox = this.#mailboxes.get(id) ?? { jobs: [], running: null };
    this.#mailboxes.set(id, mailbox);
    mailbox.jobs.push(job);
    this.#pump(id, mailbox);
  }

  /**
   * Starts working through a mailbox unless that is already happening. A
   * job can arrive after the drain's loop ends but before it is marked
   * finished, so the drain starts again if jobs are waiting when it does.
   */
  #pump(id: string, mailbox: Mailbox): void {
    if (mailbox.running !== null) return;
    mailbox.running = this.#drain(id, mailbox).finally(() => {
      mailbox.running = null;
      if (mailbox.jobs.length > 0 && !this.#closed) this.#pump(id, mailbox);
      else this.#notifyStatus(id);
    });
  }

  async #drain(id: string, mailbox: Mailbox): Promise<void> {
    for (let job = mailbox.jobs.shift(); job !== undefined; job = mailbox.jobs.shift()) {
      if (this.#closed) {
        refuse(job, new RunnerError('closed', 'the runner stopped'));
        continue;
      }
      try {
        // Jobs of one instance run one at a time, in order.
        // oxlint-disable-next-line no-await-in-loop
        await this.#run(id, job);
      } catch (error) {
        // A job that failed outside a step, such as on the store: its
        // caller is told, and an inbox result stays for the next start.
        if (job.type === 'result') this.#queued.get(id)?.delete(job.ord);
        refuse(job, error instanceof Error ? error : new Error(String(error)));
        this.#lives.delete(id);
        if (!this.#closed && !(error instanceof RunnerError)) {
          process.stderr.write(`acentric: a job of instance ${id} failed: ${String(error)}\n`);
        }
      }
    }
  }

  async #run(id: string, job: Job): Promise<void> {
    if (job.type === 'delete') {
      await this.#delete(id);
      job.done.resolve({ accepted: true });
      return;
    }
    const live = await this.#live(id);
    if (live === null) throw new RunnerError('no_instance', `no instance ${id}`);
    live.usedAt = Date.now();
    switch (job.type) {
      case 'input':
        job.resolve(
          await this.#request(live, job.input, `input:${job.input.id}`, [
            job.input.kind,
            job.input.payload,
          ]),
        );
        return;
      case 'configure': {
        const message: Message = { type: 'config', config: job.config };
        const requestId = job.requestId === null ? null : `config:${job.requestId}`;
        job.resolve(await this.#request(live, message, requestId, [job.config]));
        return;
      }
      case 'upgrade':
        job.resolve(await this.#upgrade(live, job.version));
        return;
      case 'result':
        await this.#result(live, job);
        return;
      case 'recover':
        if (live.fault === null) await this.#recover(live);
        return;
    }
  }

  /** A caller's input or config change, answered as the first time if it was seen before. */
  async #request(
    live: Live,
    message: Message,
    requestId: string | null,
    content: Json,
  ): Promise<Answer> {
    const hash = digest(content);
    if (requestId !== null) {
      const prior = await this.#store.findRequest(live.id, requestId);
      if (prior !== null) {
        if (prior.hash !== hash) {
          throw new RunnerError(
            'request_conflict',
            `${requestId} was already used for a different request`,
          );
        }
        return toAnswer(prior.answer);
      }
    }
    if (live.fault !== null) return { failed: `the instance has stopped: ${live.fault}` };
    const answer = await this.#deliver(
      live,
      message,
      requestId === null ? {} : { request: { id: requestId, hash, answer: { accepted: true } } },
    );
    if (requestId !== null && 'rejected' in answer) {
      await this.#store.putRequest(live.id, { id: requestId, hash, answer });
    }
    return answer;
  }

  async #result(live: Live, job: Extract<Job, { type: 'result' }>): Promise<void> {
    if (live.fault !== null) {
      // It stays in the inbox, to be stepped once an upgrade clears the fault.
      this.#queued.get(live.id)?.delete(job.ord);
      return;
    }
    if (!live.effects.has(job.key)) {
      // Its key was cancelled while the result waited: discarded, like any cancelled effect's.
      await this.#store.dropResult(live.id, job.ord);
      this.#queued.get(live.id)?.delete(job.ord);
      return;
    }
    const kind = live.effects.get(job.key)?.request.kind ?? '';
    // The union variant for the effect's kind is chosen at runtime.
    const message = { type: 'effect', key: job.key, kind, outcome: job.outcome } as EffectMessage;
    await this.#deliver(live, message, { consumed: job.ord, reported: job.key });
  }

  // ---- steps ----------------------------------------------------------------

  async #deliver(
    live: Live,
    message: Message,
    extra: {
      request?: { id: string; hash: string; answer: Json };
      consumed?: number;
      reported?: string;
    },
  ): Promise<Answer> {
    const now = Math.max(this.#clock(), live.lastAt);
    const state = this.#state(
      live.snapshot,
      live.windowStart,
      live.nextSeq,
      live.entries,
      live.config,
    );
    let result;
    try {
      result = live.code.agent.step(state, frozenCopy(message), now);
    } catch (error) {
      return this.#stepFailed(live, message, thrownToJson(error));
    }
    if ('error' in result) {
      if (message.type === 'input' || message.type === 'config') {
        return isJson(result.error)
          ? { rejected: result.error }
          : this.#stepFailed(live, message, 'the rejection is not plain Json');
      }
      return this.#stepFailed(live, message, `step rejected a ${message.type} message`);
    }
    const config = message.type === 'config' ? message.config : live.config;
    let prepared;
    try {
      prepared = await this.#prepare(
        live,
        live.code,
        result.snapshot,
        result.append ?? [],
        config,
        extra.reported ?? null,
        now,
      );
    } catch (error) {
      return this.#stepFailed(live, message, thrownToJson(error));
    }
    await this.#store.commit(live.id, {
      expectedSeq: live.nextSeq,
      snapshot: prepared.snapshot,
      ...(message.type === 'config' ? { config: prepared.config } : {}),
      append: prepared.entries,
      started: prepared.started,
      finished: prepared.finished,
      aborted: prepared.aborted,
      ...(extra.consumed === undefined ? {} : { consumed: extra.consumed }),
      ...(extra.request === undefined ? {} : { request: extra.request }),
    });
    const viewBefore = JSON.stringify(live.view);
    this.#apply(live, prepared, extra.consumed ?? null);
    this.#act(live, prepared);
    this.#notify(live, prepared, viewBefore);
    return { accepted: true };
  }

  /**
   * A failed step applies nothing. A caller's input or config change is
   * answered with the failure; any other message stops the instance, since
   * the same step would fail again, until an upgrade brings fixed code.
   */
  async #stepFailed(live: Live, message: Message, error: Json): Promise<Answer> {
    if (message.type !== 'input' && message.type !== 'config') {
      const fault = `a ${message.type} message's step failed: ${JSON.stringify(error)}`;
      await this.#store.setFault(live.id, fault);
      live.fault = fault;
      this.#queued.delete(live.id);
      this.#notifyStatus(live.id);
    }
    return { failed: error };
  }

  async #upgrade(live: Live, version: string): Promise<Answer> {
    let code;
    try {
      code = await this.#code({ name: live.code.ref.name, version });
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
    const from = live.code.ref.version;
    let snapshot = live.snapshot;
    let config = live.config;
    if (code.agent.migrate !== undefined) {
      let result;
      try {
        result = code.agent.migrate(live.snapshot, live.config, from);
      } catch (error) {
        return { failed: thrownToJson(error) };
      }
      if ('error' in result) return { rejected: requireJson(result.error, 'the rejection') };
      snapshot = result.snapshot;
      config = result.config ?? config;
    }
    const now = Math.max(this.#clock(), live.lastAt);
    let prepared;
    try {
      prepared = await this.#prepare(live, code, snapshot, [], config, null, now);
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    const faulted = live.fault !== null;
    await this.#store.commit(live.id, {
      expectedSeq: live.nextSeq,
      snapshot: prepared.snapshot,
      config: prepared.config,
      agent: code.ref,
      ...(faulted ? { clearFault: true } : {}),
      append: [],
      started: prepared.started,
      finished: prepared.finished,
      aborted: prepared.aborted,
    });
    live.fault = null;
    const viewBefore = JSON.stringify(live.view);
    this.#apply(live, prepared, null);
    this.#act(live, prepared);
    this.#notify(live, prepared, viewBefore);
    await this.#deliver(live, { type: 'migrated', from }, {});
    if (faulted && live.fault === null) await this.#recover(live);
    return { accepted: true };
  }

  #state(
    snapshot: JsonObject,
    start: number,
    next: number,
    entries: readonly LogEntry[],
    config: JsonObject,
  ): State<JsonObject, JsonObject> {
    return deepFreeze({ snapshot, log: { start, next, entries: [...entries] }, config });
  }

  /**
   * Checks everything a step's result leads to, changing nothing: its
   * snapshot and appends are Json, the window and view work on the new
   * state, and the effects it declares name each key once. Throws on the
   * first problem.
   */
  async #prepare(
    live: Live,
    code: Code,
    snapshotValue: unknown,
    append: readonly LogAppend[],
    config: JsonObject,
    reported: string | null,
    now: number,
  ): Promise<Prepared> {
    const checked = requireJson(snapshotValue, 'the snapshot');
    if (typeof checked !== 'object' || checked === null || Array.isArray(checked)) {
      throw new TypeError('the snapshot is not an object');
    }
    const snapshot = frozenCopy(checked);
    const entries = append.map(({ kind, body }, index) => {
      if (typeof kind !== 'string') throw new TypeError('a log entry kind is not a string');
      return deepFreeze({
        seq: live.nextSeq + index,
        at: now,
        kind,
        body: structuredClone(requireJson(body, `the body of a ${kind} entry`)),
      });
    });
    const next = live.nextSeq + entries.length;
    const windowStart = startOf(code, snapshot, next);
    const windowEntries = [...(await this.#entriesFrom(live, windowStart)), ...entries];
    const state = this.#state(snapshot, windowStart, next, windowEntries, config);
    const view =
      code.agent.view === undefined ? null : requireJson(code.agent.view(state), 'the view');
    const list = code.agent.effects?.(state) ?? [];

    const previous = new Map(live.effects);
    if (reported !== null) previous.delete(reported);
    const fresh = list
      .map((request) => request.key)
      .filter((key) => key !== reported && !previous.has(key));
    const finished =
      fresh.length === 0 ? new Set<string>() : await this.#store.findFinished(live.id, fresh);
    const effects = new Map<string, StoredEffect>();
    const seen = new Set<string>();
    const started: StoredEffect[] = [];
    const aborted: string[] = [];
    for (const request of list) {
      requireJson(request, `the effect request ${request.key}`);
      if (seen.has(request.key)) throw new Error(`effect ${request.key} is declared twice`);
      seen.add(request.key);
      if (request.key === reported || finished.has(request.key)) continue;
      const before = previous.get(request.key);
      if (before !== undefined) {
        const abort = request.abort === true && before.request.abort !== true;
        if (abort) aborted.push(request.key);
        effects.set(
          request.key,
          abort ? { ...before, request: deepFreeze({ ...before.request, abort: true }) } : before,
        );
      } else {
        const effect: StoredEffect = {
          request: frozenCopy(request),
          mode: request.mode ?? code.kinds[request.kind]?.mode ?? 'reissue',
          attempt: 1,
        };
        effects.set(request.key, effect);
        started.push(effect);
      }
    }
    const cancelled = [...previous.keys()].filter((key) => !effects.has(key));
    return {
      code,
      snapshot,
      config: frozenCopy(config),
      entries,
      windowStart,
      windowEntries: windowEntries.filter((entry) => entry.seq >= windowStart),
      effects,
      started,
      cancelled,
      aborted,
      finished: [...(reported === null ? [] : [reported]), ...cancelled],
      view,
    };
  }

  /** The instance's entries from `start` on, reading older ones from the store if the window moved back. */
  async #entriesFrom(live: Live, start: number): Promise<LogEntry[]> {
    if (start >= live.windowStart) return live.entries.filter((entry) => entry.seq >= start);
    const older = await this.#store.readLog(live.id, {
      after: start - 1,
      before: live.windowStart,
    });
    return [...older.map((entry) => deepFreeze(entry)), ...live.entries];
  }

  #apply(live: Live, prepared: Prepared, consumed: number | null): void {
    live.code = prepared.code;
    live.snapshot = prepared.snapshot;
    live.config = prepared.config;
    live.nextSeq += prepared.entries.length;
    live.entries = prepared.windowEntries;
    live.windowStart = prepared.windowStart;
    live.lastAt = prepared.entries.at(-1)?.at ?? live.lastAt;
    live.effects = prepared.effects;
    live.view = prepared.view;
    if (consumed !== null) this.#queued.get(live.id)?.delete(consumed);
  }

  /** After a step is saved: cancel, abort and start effects. */
  #act(live: Live, prepared: Prepared): void {
    const flights = this.#flightsOf(live.id);
    for (const key of prepared.cancelled) {
      const flight = flights.get(key);
      if (flight === undefined) continue;
      flight.cancelled = true;
      flights.delete(key);
      this.#scheduler.remove(timerId(live.id, key));
      if (flight.timer !== null) clearTimeout(flight.timer);
      this.#hosts.cancel(flight.hash, live.id, key);
    }
    for (const key of prepared.aborted) {
      const flight = flights.get(key);
      if (flight === undefined) continue;
      flight.aborted = true;
      this.#hosts.cancel(flight.hash, live.id, key);
    }
    for (const effect of prepared.started) this.#start(live.id, live.code, effect);
  }

  // ---- effects --------------------------------------------------------------

  #start(id: string, code: Code, effect: StoredEffect): void {
    const { key, kind, args } = effect.request;
    const flight: Flight = {
      key,
      kind,
      hash: code.hash,
      done: false,
      cancelled: false,
      aborted: effect.request.abort === true,
      timer: null,
      active: false,
    };
    this.#flightsOf(id).set(key, flight);
    if (kind === '@timer') {
      const at =
        typeof args === 'object' && args !== null && !Array.isArray(args) ? args['at'] : undefined;
      if (typeof at !== 'number') {
        this.#background(
          this.#finish(id, flight, { failed: { code: 'threw', error: '@timer needs { at }' } }),
        );
        return;
      }
      this.#scheduler.add(timerId(id, key), at, () =>
        this.#background(this.#finish(id, flight, { ok: null })),
      );
      return;
    }
    const info = kind.startsWith('@') ? undefined : code.kinds[kind];
    if (info === undefined) {
      this.#background(this.#finish(id, flight, { failed: { code: 'unknown_kind', error: kind } }));
      return;
    }
    flight.active = true;
    const timeoutMs = info.timeoutMs ?? this.#timeoutMs;
    if (timeoutMs !== undefined) {
      flight.timer = setTimeout(() => {
        this.#hosts.cancel(code.hash, id, key);
        this.#background(
          this.#finish(id, flight, { failed: { code: 'timeout', error: { timeoutMs } } }),
        );
      }, timeoutMs);
    }
    this.#background(
      this.#hosts
        .run(code.hash, code.handlersPath, {
          instance: id,
          key,
          kind,
          args,
          attempt: effect.attempt,
        })
        .then((outcome) => this.#ran(id, code, effect, flight, outcome)),
    );
  }

  async #ran(
    id: string,
    code: Code,
    effect: StoredEffect,
    flight: Flight,
    outcome: HostOutcome,
  ): Promise<void> {
    if (flight.done || this.#closed) return;
    if ('crashed' in outcome) {
      // The host went away mid-run: a crash, for this effect only.
      if (effect.mode === 'once') {
        await this.#finish(id, flight, { interrupted: true });
        return;
      }
      const limit = code.kinds[effect.request.kind]?.maxAttempts ?? this.#maxAttempts;
      if (effect.attempt + 1 > limit) {
        await this.#finish(id, flight, {
          failed: { code: 'attempts_exhausted', error: { attempts: effect.attempt } },
        });
        return;
      }
      flight.done = true;
      if (flight.timer !== null) clearTimeout(flight.timer);
      if (flight.cancelled) return;
      await this.#rerun(id, code, effect);
      return;
    }
    const result: Outcome =
      'value' in outcome
        ? { ok: outcome.value }
        : 'invalid' in outcome
          ? { failed: { code: 'invalid_result', error: 'the result is not plain Json' } }
          : { failed: { code: flight.aborted ? 'aborted' : 'threw', error: outcome.thrown } };
    await this.#finish(id, flight, result);
  }

  /** Runs a reissue effect again with its next attempt, recorded first. */
  async #rerun(id: string, code: Code, effect: StoredEffect): Promise<void> {
    const next: StoredEffect = { ...effect, attempt: effect.attempt + 1 };
    await this.#store.recordAttempt(id, effect.request.key, next.attempt);
    const live = await this.#lives.get(id);
    if (live?.effects.has(effect.request.key) === true) live.effects.set(effect.request.key, next);
    if (!this.#closed) this.#start(id, code, next);
  }

  /** An effect ended: its outcome is saved to the inbox, then stepped, unless it was cancelled. */
  async #finish(id: string, flight: Flight, outcome: Outcome): Promise<void> {
    if (flight.done || this.#closed) return;
    flight.done = true;
    if (flight.timer !== null) clearTimeout(flight.timer);
    if (flight.cancelled) return;
    const ord = await this.#store.putResult(id, flight.key, outcome);
    if (this.#closed) return;
    const flights = this.#flights.get(id);
    if (flights?.get(flight.key) === flight) flights.delete(flight.key);
    this.#queuedOf(id).add(ord);
    this.#enqueue(id, { type: 'result', ord, key: flight.key, outcome });
    flight.active = false;
  }

  #emitted(id: string, key: string, delta: Json): void {
    const flight = this.#flights.get(id)?.get(key);
    if (flight === undefined || flight.done) return;
    for (const subscriber of this.#subscribers.get(id) ?? []) {
      if (subscriber.emits) subscriber.listener({ type: 'emit', key, delta });
    }
  }

  // ---- recovery -------------------------------------------------------------

  /**
   * Picks up an instance's effects that no handler in this runner is
   * running: inbox results are stepped first, then running effects are
   * reported interrupted, run again or scheduled again. The effects in the
   * store are what the last step declared, from the same code, so they are
   * taken as they are.
   */
  async #recover(live: Live): Promise<void> {
    const inbox = await this.#store.inbox(live.id);
    const queued = this.#queuedOf(live.id);
    for (const item of inbox) {
      if (queued.has(item.ord)) continue;
      queued.add(item.ord);
      this.#enqueue(live.id, { type: 'result', ...item });
    }
    const answered = new Set(inbox.map((item) => item.key));
    const flights = this.#flightsOf(live.id);
    for (const effect of live.effects.values()) {
      const { key, kind } = effect.request;
      if (flights.has(key) || answered.has(key)) continue;
      if (kind === '@timer') {
        this.#start(live.id, live.code, effect);
      } else if (effect.mode === 'once') {
        // Recovery handles effects one at a time, in the order they started.
        // oxlint-disable-next-line no-await-in-loop
        await this.#report(live.id, key, { interrupted: true });
      } else if (effect.attempt + 1 > (live.code.kinds[kind]?.maxAttempts ?? this.#maxAttempts)) {
        // oxlint-disable-next-line no-await-in-loop
        await this.#report(live.id, key, {
          failed: { code: 'attempts_exhausted', error: { attempts: effect.attempt } },
        });
      } else {
        // oxlint-disable-next-line no-await-in-loop
        await this.#rerun(live.id, live.code, effect);
      }
    }
  }

  /** Reports an outcome for a key no handler is running, through the inbox. */
  async #report(id: string, key: string, outcome: Outcome): Promise<void> {
    const ord = await this.#store.putResult(id, key, outcome);
    this.#queuedOf(id).add(ord);
    this.#enqueue(id, { type: 'result', ord, key, outcome });
  }

  async #delete(id: string): Promise<void> {
    for (const [key, flight] of this.#flights.get(id) ?? []) {
      flight.cancelled = true;
      this.#scheduler.remove(timerId(id, key));
      if (flight.timer !== null) clearTimeout(flight.timer);
      this.#hosts.cancel(flight.hash, id, key);
    }
    this.#flights.delete(id);
    await this.#store.delete(id);
    this.#lives.delete(id);
    this.#queued.delete(id);
    this.#subscribers.delete(id);
    this.#statuses.delete(id);
  }

  // ---- loading --------------------------------------------------------------

  #live(id: string): Promise<Live | null> {
    const cached = this.#lives.get(id);
    if (cached !== undefined) return cached;
    const loading = this.#load(id);
    this.#lives.set(id, loading);
    loading.then(
      (live) => {
        if (live === null && this.#lives.get(id) === loading) this.#lives.delete(id);
      },
      () => {
        if (this.#lives.get(id) === loading) this.#lives.delete(id);
      },
    );
    return loading;
  }

  async #load(id: string): Promise<Live | null> {
    const record = await this.#store.load(id);
    if (record === null) return null;
    const code = await this.#code(record.agent);
    const windowStart = startOf(code, record.snapshot, record.nextSeq);
    const entries =
      windowStart < record.nextSeq ? await this.#store.readLog(id, { after: windowStart - 1 }) : [];
    const newest =
      entries.at(-1) ??
      (record.nextSeq > 1
        ? (await this.#store.readLog(id, { after: record.nextSeq - 2 }))[0]
        : undefined);
    const live: Live = {
      id,
      code,
      config: deepFreeze(record.config),
      snapshot: deepFreeze(record.snapshot),
      nextSeq: record.nextSeq,
      fault: record.fault,
      entries: entries.map((entry) => deepFreeze(entry)),
      windowStart,
      lastAt: newest?.at ?? 0,
      effects: new Map(record.running.map((effect) => [effect.request.key, deepFreeze(effect)])),
      view: null,
      usedAt: Date.now(),
    };
    const state = this.#state(live.snapshot, windowStart, live.nextSeq, live.entries, live.config);
    live.view =
      code.agent.view === undefined ? null : requireJson(code.agent.view(state), 'the view');
    return live;
  }

  #code(ref: AgentRef): Promise<Code> {
    const id = `${ref.name}@${ref.version}`;
    const cached = this.#codes.get(id);
    if (cached !== undefined) return cached;
    const loading = (async (): Promise<Code> => {
      const bundle = await this.#store.getBundle(ref);
      if (bundle === null) throw new RunnerError('no_agent', `agent ${id} is not deployed`);
      const files = await this.#write(bundle.hash, bundle.agent, bundle.handlers);
      return {
        ref: { name: bundle.name, version: bundle.version },
        hash: bundle.hash,
        agent: await importAgent(files.agentPath),
        kinds: bundle.kinds,
        handlersPath: files.handlersPath,
      };
    })();
    this.#codes.set(id, loading);
    loading.catch(() => this.#codes.delete(id));
    return loading;
  }

  /** Writes a bundle's modules where they can be imported, named by hash so a version never collides with another. */
  async #write(
    hash: string,
    agent: string,
    handlers: string,
  ): Promise<{ agentPath: string; handlersPath: string }> {
    const dir = join(this.#codeDir, hash);
    const agentPath = join(dir, 'agent.mjs');
    const handlersPath = join(dir, 'handlers.mjs');
    await mkdir(dir, { recursive: true });
    await Promise.all([writeOnce(agentPath, agent), writeOnce(handlersPath, handlers)]);
    return { agentPath, handlersPath };
  }

  #unloadIdle(): void {
    const now = Date.now();
    for (const [id, loading] of this.#lives) {
      const mailbox = this.#mailboxes.get(id);
      if (mailbox !== undefined && (mailbox.running !== null || mailbox.jobs.length > 0)) continue;
      void loading.then((live) => {
        if (live !== null && now - live.usedAt >= this.#idleMs && this.#lives.get(id) === loading) {
          const box = this.#mailboxes.get(id);
          if (box === undefined || (box.running === null && box.jobs.length === 0))
            this.#lives.delete(id);
        }
      });
    }
  }

  // ---- status and notifications ---------------------------------------------

  #running(live: Live): RunningEffect[] {
    const flights = this.#flights.get(live.id);
    return [...live.effects.values()].map(({ request, attempt }) => {
      const flight = flights?.get(request.key);
      return {
        key: request.key,
        kind: request.kind,
        args: request.args,
        attempt,
        abort: request.abort === true,
        active: flight !== undefined && !flight.done && flight.active,
      };
    });
  }

  #working(id: string): boolean {
    const mailbox = this.#mailboxes.get(id);
    return mailbox !== undefined && (mailbox.running !== null || mailbox.jobs.length > 0);
  }

  #status(id: string, fault: string | null): Status {
    if (fault !== null) return 'faulted';
    if (this.#working(id)) return 'busy';
    const flights = this.#flights.get(id);
    return flights !== undefined && flights.size > 0 ? 'busy' : 'idle';
  }

  /** Tells subscribers what a saved step changed: its entries, and the view if it changed. */
  #notify(live: Live, prepared: Prepared, viewBefore: string): void {
    const subscribers = this.#subscribers.get(live.id);
    if (subscribers !== undefined) {
      const viewChanged = JSON.stringify(prepared.view) !== viewBefore;
      for (const subscriber of subscribers) {
        if (prepared.entries.length > 0) {
          if (subscriber.held === null)
            subscriber.listener({ type: 'log', entries: prepared.entries });
          else subscriber.held.push(...prepared.entries);
        }
        if (viewChanged && subscriber.held === null)
          subscriber.listener({ type: 'view', view: prepared.view });
      }
    }
    this.#notifyStatus(live.id);
  }

  #notifyStatus(id: string): void {
    const subscribers = this.#subscribers.get(id);
    if (subscribers === undefined) return;
    void this.#lives.get(id)?.then((live) => {
      if (live === null) return;
      const status = this.#status(id, live.fault);
      if (this.#statuses.get(id) === status) return;
      this.#statuses.set(id, status);
      for (const subscriber of subscribers) {
        if (subscriber.held === null)
          subscriber.listener({ type: 'status', status, fault: live.fault });
      }
    });
  }

  // ---- helpers --------------------------------------------------------------

  #open(): void {
    if (this.#closing) throw new RunnerError('closed', 'the runner is closed');
  }

  #flightsOf(id: string): Map<string, Flight> {
    const flights = this.#flights.get(id) ?? new Map<string, Flight>();
    this.#flights.set(id, flights);
    return flights;
  }

  #queuedOf(id: string): Set<number> {
    const queued = this.#queued.get(id) ?? new Set<number>();
    this.#queued.set(id, queued);
    return queued;
  }

  #activeFlights(): number {
    let count = 0;
    for (const flights of this.#flights.values()) {
      for (const flight of flights.values()) if (flight.active && !flight.done) count += 1;
    }
    return count;
  }

  /** Runs work no caller waits on, reporting a failure unless the runner has stopped. */
  #background(work: Promise<void>): void {
    work.catch((error: unknown) => {
      if (!this.#closed) process.stderr.write(`acentric: ${String(error)}\n`);
    });
  }
}

/** Where an instance's window starts: what `window` asks for, kept within the log. */
function startOf(code: Code, snapshot: JsonObject, next: number): number {
  const asked = code.agent.window?.(snapshot) ?? 1;
  if (typeof asked !== 'number' || Number.isNaN(asked)) {
    throw new TypeError(`window returned ${String(asked)}, not a number`);
  }
  return Math.min(Math.max(Math.floor(asked), 1), next);
}

function timerId(id: string, key: string): string {
  return `${id}\u0000${key}`;
}

function digest(value: Json): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function refuse(job: Job, error: Error): void {
  if ('reject' in job) job.reject(error);
  else if (job.type === 'delete') job.done.reject(error);
}

function toAnswer(value: Json): Answer {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if ('rejected' in value) return { rejected: value['rejected'] ?? null };
    if ('failed' in value) return { failed: value['failed'] ?? null };
  }
  return { accepted: true };
}

async function writeOnce(path: string, source: string): Promise<void> {
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (exists) return;
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  await writeFile(temporary, source);
  await rename(temporary, path);
}

async function importAgent(path: string): Promise<Agent<JsonObject, JsonObject>> {
  const module: unknown = await import(pathToFileURL(path).href);
  const agent: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined;
  if (!isAgent(agent)) throw new Error('the agent module has no default export with init and step');
  return agent;
}

function isAgent(value: unknown): value is Agent<JsonObject, JsonObject> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'init') === 'function' &&
    typeof Reflect.get(value, 'step') === 'function'
  );
}
