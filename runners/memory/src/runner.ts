// The memory runner: runs agents' instances in this process, following
// RUNNERS.md, and keeps their state in a memory store.
//
// Each instance has a mailbox. Messages are taken one at a time: the step
// runs, its result is checked, and then everything it changes is applied at
// once. Only after that do new handlers start, cancelled and aborted ones
// get their signal, and the caller get its answer. Handlers run in this
// process, at the same time as each other; when one finishes, its result
// joins the mailbox.

import type {
  Agent,
  EffectMessage,
  HandlerContext,
  HandlerDef,
  Json,
  JsonObject,
  Kinds,
  LogEntry,
  LogPage,
  LogQuery,
  Message,
  Mode,
  Outcome,
  State,
} from '@acentric/types';

import { deepFreeze, frozenCopy, isJson, requireJson, thrownToJson } from './json.js';
import { createMemoryStore } from './store.js';
import type { MemoryStore, StoredEffect, StoredInstance } from './store.js';

/** What a caller is told about a create, input, config change or upgrade. */
export type Answer = { accepted: true } | { rejected: Json } | { failed: Json };

/** An agent the runner has loaded, by the name and version that identify its code. */
export type LoadedAgent = { readonly name: string; readonly version: string };

export type RunningEffect = {
  key: string;
  kind: string;
  args: Json;
  attempt: number;
  abort: boolean;
  /** Whether a handler is executing it now, as opposed to a timer waiting. */
  active: boolean;
};

export type EmitListener = (key: string, delta: Json) => void;

/** The built-in kinds this runner provides, for an agent's map of kinds. */
export type MemoryRunnerKinds = {
  /** Fires at `at`, in milliseconds since the Unix epoch, and returns null. */
  '@timer': { args: { at: number }; result: null };
};

export type MemoryRunnerOptions = {
  /** Where state is kept. A new runner over an existing store recovers what it holds. */
  store?: MemoryStore;
  /** Secret values by name, for handlers. */
  secrets?: Record<string, string>;
  /** The clock, in milliseconds since the Unix epoch. Defaults to Date.now. */
  clock?: () => number;
  /** A handler's time limit when it sets none. Defaults to none. */
  timeoutMs?: number;
  /** Runs of one reissue key when its handler sets no limit. Defaults to 5. */
  maxAttempts?: number;
};

type Registered = {
  agent: Agent<JsonObject, JsonObject>;
  handlers: Readonly<Record<string, HandlerDef | undefined>>;
};

type Flight = {
  controller: AbortController;
  done: boolean;
  aborted: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
};

type Job =
  | { kind: 'message'; message: Message; reported: string | null; answer: (answer: Answer) => void }
  | { kind: 'upgrade'; agent: LoadedAgent; answer: (answer: Answer) => void };

/** A step's result, checked and ready to apply. */
type Prepared = {
  snapshot: JsonObject;
  config: JsonObject;
  entries: LogEntry[];
  effects: Map<string, StoredEffect>;
  finished: Set<string>;
  started: string[];
  cancelled: string[];
  aborted: string[];
};

const PAGE_SIZE = 100;

export function createMemoryRunner(options: MemoryRunnerOptions = {}): MemoryRunner {
  return new MemoryRunner(options);
}

export class MemoryRunner {
  readonly store: MemoryStore;
  readonly #secrets: Record<string, string>;
  readonly #clock: () => number;
  readonly #timeoutMs: number | undefined;
  readonly #maxAttempts: number;
  readonly #agents = new Map<string, Registered>();
  readonly #mailboxes = new Map<string, Job[]>();
  readonly #draining = new Set<string>();
  readonly #flights = new Map<string, Map<string, Flight>>();
  readonly #listeners = new Map<string, Set<EmitListener>>();
  #closed = false;

  constructor(options: MemoryRunnerOptions) {
    this.store = options.store ?? createMemoryStore();
    this.#secrets = options.secrets ?? {};
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMs = options.timeoutMs;
    this.#maxAttempts = options.maxAttempts ?? 5;
  }

  // ---- agents ---------------------------------------------------------------

  /**
   * Loads an agent: its pure half and its handlers. Throws if a handler is
   * named with `@`, or if a different agent was loaded under the same name
   * and version.
   */
  load<S extends JsonObject, C extends JsonObject, K extends Kinds>(
    agent: Agent<S, C, K>,
    handlers: Readonly<Record<string, HandlerDef | undefined>> = agent.handlers ?? {},
  ): LoadedAgent {
    const reserved = Object.keys(handlers).filter((name) => name.startsWith('@'));
    if (reserved.length > 0) {
      throw new Error(`handler names starting with @ belong to runners: ${reserved.join(', ')}`);
    }
    const id = `${agent.name}@${agent.version}`;
    const erased = erase(agent);
    const existing = this.#agents.get(id);
    if (existing !== undefined && existing.agent !== erased) {
      throw new Error(`a different agent is already loaded as ${id}`);
    }
    this.#agents.set(id, { agent: erased, handlers });
    return { name: agent.name, version: agent.version };
  }

  // ---- instances ------------------------------------------------------------

  /** Creates an instance, running init. Its id defaults to 'instance-1', 'instance-2', ... */
  create(agent: LoadedAgent, config: JsonObject, id?: string): Answer & { id?: string } {
    const registered = this.#registered(agent);
    if (!isJson(config)) return { failed: 'the config is not plain Json' };
    const now = this.#clock();
    let result;
    try {
      result = registered.agent.init(frozenCopy(config), now);
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    if ('error' in result) return { rejected: requireJson(result.error, 'the rejection') };

    this.store.created += 1;
    const instance: StoredInstance = {
      id: id ?? `instance-${this.store.created}`,
      agent: { name: agent.name, version: agent.version },
      config: frozenCopy(config),
      snapshot: {},
      log: [],
      effects: new Map(),
      finished: new Set(),
      fault: null,
    };
    let prepared;
    try {
      prepared = this.#prepare(
        instance,
        registered,
        result.snapshot,
        result.append ?? [],
        config,
        null,
        now,
      );
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    this.store.instances.set(instance.id, instance);
    this.#apply(instance, prepared);
    this.#act(instance, registered, prepared);
    return { accepted: true, id: instance.id };
  }

  /** Sends an input, answering once its step is saved. The id defaults to a new one. */
  input(instanceId: string, kind: string, payload: JsonObject, inputId?: string): Promise<Answer> {
    const id = inputId ?? globalThis.crypto.randomUUID();
    return this.#send(instanceId, { type: 'input', id, kind, payload });
  }

  /** Changes an instance's config, answering once its step is saved. */
  configure(instanceId: string, config: JsonObject): Promise<Answer> {
    return this.#send(instanceId, { type: 'config', config });
  }

  /** Moves an instance onto another loaded version of its agent, between steps. */
  upgrade(instanceId: string, agent: LoadedAgent): Promise<Answer> {
    return new Promise((answer) => {
      this.#enqueue(instanceId, { kind: 'upgrade', agent, answer });
    });
  }

  snapshot(instanceId: string): JsonObject {
    return this.#instance(instanceId).snapshot;
  }

  config(instanceId: string): JsonObject {
    return this.#instance(instanceId).config;
  }

  /** The whole log, oldest first. */
  log(instanceId: string): readonly LogEntry[] {
    return this.#instance(instanceId).log;
  }

  /** What the agent's view shows, or null if it has none. */
  view(instanceId: string): Json {
    const instance = this.#instance(instanceId);
    const registered = this.#registered(instance.agent);
    return (
      registered.agent.view?.(
        this.#state(registered, instance.snapshot, instance.log, instance.config),
      ) ?? null
    );
  }

  /** The instance's declared, unfinished effects, in the order they started. */
  running(instanceId: string): RunningEffect[] {
    const instance = this.#instance(instanceId);
    const flights = this.#flights.get(instanceId);
    return [...instance.effects.values()].map(({ request, attempt }) => {
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

  /** Why the instance stopped taking messages, or null if it has not. */
  fault(instanceId: string): string | null {
    return this.#instance(instanceId).fault;
  }

  /** Listens to what the instance's handlers emit. Returns a function that stops listening. */
  onEmit(instanceId: string, listener: EmitListener): () => void {
    const listeners = this.#listeners.get(instanceId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(instanceId, listeners);
    return () => listeners.delete(listener);
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Recovers every stored instance whose agent is loaded, as after a crash:
   * effects are matched again, reissue effects that were running run again
   * with the next attempt, once effects that were running are reported
   * interrupted, and timers are scheduled again.
   */
  start(): void {
    for (const instance of this.store.instances.values()) {
      const registered = this.#agents.get(`${instance.agent.name}@${instance.agent.version}`);
      if (registered !== undefined && instance.fault === null) this.#recover(instance, registered);
    }
  }

  /**
   * Stops abruptly: handlers get their signal and nothing they do afterwards
   * is kept. The store keeps what was saved, for a new runner to recover.
   */
  close(): void {
    this.#closed = true;
    for (const flights of this.#flights.values()) {
      for (const flight of flights.values()) {
        if (flight.timer !== null) clearTimeout(flight.timer);
        flight.controller.abort();
      }
    }
  }

  // ---- delivering messages --------------------------------------------------

  #send(instanceId: string, message: Message): Promise<Answer> {
    return new Promise((answer) => {
      this.#enqueue(instanceId, { kind: 'message', message, reported: null, answer });
    });
  }

  #enqueue(instanceId: string, job: Job): void {
    if (this.#closed) {
      job.answer({ failed: 'the runner is closed' });
      return;
    }
    const mailbox = this.#mailboxes.get(instanceId) ?? [];
    mailbox.push(job);
    this.#mailboxes.set(instanceId, mailbox);
    this.#drain(instanceId);
  }

  /** Takes jobs one at a time. A job started while draining waits its turn. */
  #drain(instanceId: string): void {
    if (this.#draining.has(instanceId)) return;
    this.#draining.add(instanceId);
    try {
      const mailbox = this.#mailboxes.get(instanceId) ?? [];
      for (let job = mailbox.shift(); job !== undefined; job = mailbox.shift()) {
        job.answer(this.#run(instanceId, job));
      }
    } finally {
      this.#draining.delete(instanceId);
    }
  }

  #run(instanceId: string, job: Job): Answer {
    if (this.#closed) return { failed: 'the runner is closed' };
    const instance = this.store.instances.get(instanceId);
    if (instance === undefined) return { failed: `no instance ${instanceId}` };
    if (instance.fault !== null) return { failed: `the instance has stopped: ${instance.fault}` };
    if (job.kind === 'upgrade') return this.#upgrade(instance, job.agent);
    // A result can wait in the mailbox while a step before it cancels its
    // key. The result is then discarded, like any cancelled effect's.
    if (job.reported !== null && !instance.effects.has(job.reported)) return { accepted: true };
    return this.#deliver(instance, this.#registered(instance.agent), job.message, job.reported);
  }

  #deliver(
    instance: StoredInstance,
    registered: Registered,
    message: Message,
    reported: string | null,
  ): Answer {
    const now = this.#now(instance);
    const state = this.#state(registered, instance.snapshot, instance.log, instance.config);
    let result;
    try {
      result = registered.agent.step(state, frozenCopy(message), now);
    } catch (error) {
      return this.#stepFailed(instance, message, thrownToJson(error));
    }
    if ('error' in result) {
      if (message.type === 'input' || message.type === 'config') {
        return isJson(result.error)
          ? { rejected: result.error }
          : this.#stepFailed(instance, message, 'the rejection is not plain Json');
      }
      return this.#stepFailed(instance, message, `step rejected a ${message.type} message`);
    }
    const config = message.type === 'config' ? message.config : instance.config;
    let prepared;
    try {
      prepared = this.#prepare(
        instance,
        registered,
        result.snapshot,
        result.append ?? [],
        config,
        reported,
        now,
      );
    } catch (error) {
      return this.#stepFailed(instance, message, thrownToJson(error));
    }
    this.#apply(instance, prepared);
    this.#act(instance, registered, prepared);
    return { accepted: true };
  }

  /**
   * A failed step applies nothing. A caller's input or config change is
   * answered with the failure and dropped; any other message stops the
   * instance, since a pure step would fail the same way again.
   */
  #stepFailed(instance: StoredInstance, message: Message, error: Json): Answer {
    if (message.type !== 'input' && message.type !== 'config') {
      instance.fault = `a ${message.type} message's step failed: ${JSON.stringify(error)}`;
    }
    return { failed: error };
  }

  #upgrade(instance: StoredInstance, agent: LoadedAgent): Answer {
    const registered = this.#registered(agent);
    const from = instance.agent.version;
    let snapshot = instance.snapshot;
    let config = instance.config;
    const migrate = registered.agent.migrate;
    if (migrate !== undefined) {
      let result;
      try {
        result = migrate(instance.snapshot, instance.config, from);
      } catch (error) {
        return { failed: thrownToJson(error) };
      }
      if ('error' in result) return { rejected: requireJson(result.error, 'the rejection') };
      snapshot = result.snapshot;
      config = result.config ?? config;
    }
    let prepared;
    try {
      prepared = this.#prepare(
        instance,
        registered,
        snapshot,
        [],
        config,
        null,
        this.#now(instance),
      );
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    instance.agent = { name: agent.name, version: agent.version };
    this.#apply(instance, prepared);
    this.#act(instance, registered, prepared);
    this.#deliver(instance, registered, { type: 'migrated', from }, null);
    return { accepted: true };
  }

  // ---- checking and applying a step -----------------------------------------

  /** `now` for a step: the clock, but never earlier than the instance's newest entry. */
  #now(instance: StoredInstance): number {
    return Math.max(this.#clock(), instance.log.at(-1)?.at ?? 0);
  }

  #state(
    registered: Registered,
    snapshot: JsonObject,
    log: readonly LogEntry[],
    config: JsonObject,
  ): State<JsonObject, JsonObject> {
    const next = log.length + 1;
    const asked = registered.agent.window?.(snapshot) ?? 1;
    if (typeof asked !== 'number' || Number.isNaN(asked)) {
      throw new TypeError(`window returned ${String(asked)}, not a number`);
    }
    const start = Math.min(Math.max(Math.floor(asked), 1), next);
    return deepFreeze({ snapshot, log: { start, next, entries: log.slice(start - 1) }, config });
  }

  /**
   * Checks everything a step's result leads to, changing nothing: its
   * snapshot and appends are Json, the window and view work on the new
   * state, and the effects it declares name each key once. Throws on the
   * first problem.
   */
  #prepare(
    instance: StoredInstance,
    registered: Registered,
    snapshotValue: unknown,
    append: readonly { kind: string; body: Json }[],
    config: JsonObject,
    reported: string | null,
    now: number,
  ): Prepared {
    const snapshot = requireJson(snapshotValue, 'the snapshot');
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      throw new TypeError('the snapshot is not an object');
    }
    const entries = append.map(({ kind, body }, index) => {
      if (typeof kind !== 'string') throw new TypeError('a log entry kind is not a string');
      return deepFreeze({
        seq: instance.log.length + 1 + index,
        at: now,
        kind,
        body: structuredClone(requireJson(body, `the body of a ${kind} entry`)),
      });
    });
    const frozenSnapshot = frozenCopy(snapshot);
    const state = this.#state(registered, frozenSnapshot, [...instance.log, ...entries], config);
    if (registered.agent.view !== undefined) requireJson(registered.agent.view(state), 'the view');
    const list = registered.agent.effects?.(state) ?? [];

    const finished = new Set(instance.finished);
    const previous = new Map(instance.effects);
    if (reported !== null) {
      previous.delete(reported);
      finished.add(reported);
    }
    const effects = new Map<string, StoredEffect>();
    const started: string[] = [];
    const aborted: string[] = [];
    for (const request of list) {
      requireJson(request, `the effect request ${request.key}`);
      if (effects.has(request.key) || started.includes(request.key)) {
        throw new Error(`effect ${request.key} is declared twice`);
      }
      if (finished.has(request.key)) continue;
      const before = previous.get(request.key);
      if (before !== undefined) {
        const abort = request.abort === true && before.request.abort !== true;
        if (abort) aborted.push(request.key);
        effects.set(
          request.key,
          abort ? { ...before, request: deepFreeze({ ...before.request, abort: true }) } : before,
        );
      } else {
        effects.set(request.key, {
          request: frozenCopy(request),
          mode: request.mode ?? this.#mode(registered, request.kind),
          attempt: 1,
        });
        started.push(request.key);
      }
    }
    const cancelled = [...previous.keys()].filter((key) => !effects.has(key));
    for (const key of cancelled) finished.add(key);
    return {
      snapshot: frozenSnapshot,
      config: frozenCopy(config),
      entries,
      effects,
      finished,
      started,
      cancelled,
      aborted,
    };
  }

  #apply(instance: StoredInstance, prepared: Prepared): void {
    instance.snapshot = prepared.snapshot;
    instance.config = prepared.config;
    instance.log.push(...prepared.entries);
    instance.effects = prepared.effects;
    instance.finished = prepared.finished;
  }

  /** After a step is applied: cancel, abort and start effects. */
  #act(instance: StoredInstance, registered: Registered, prepared: Prepared): void {
    const flights = this.#flightsOf(instance.id);
    for (const key of prepared.cancelled) {
      const flight = flights.get(key);
      if (flight === undefined) continue;
      flight.cancelled = true;
      if (flight.timer !== null) clearTimeout(flight.timer);
      flight.controller.abort();
    }
    for (const key of prepared.aborted) {
      const flight = flights.get(key);
      if (flight === undefined) continue;
      flight.aborted = true;
      flight.controller.abort();
    }
    for (const key of prepared.started) this.#start(instance, registered, key);
  }

  #mode(registered: Registered, kind: string): Mode {
    return registered.handlers[kind]?.mode ?? 'reissue';
  }

  // ---- running effects ------------------------------------------------------

  #start(instance: StoredInstance, registered: Registered, key: string): void {
    const effect = instance.effects.get(key);
    if (effect === undefined) return;
    const { request } = effect;
    if (request.kind === '@timer') {
      this.#startTimer(instance, key, request.args);
      return;
    }
    const handler = request.kind.startsWith('@') ? undefined : registered.handlers[request.kind];
    if (handler === undefined) {
      this.#report(instance.id, key, request.kind, {
        failed: { code: 'unknown_kind', error: request.kind },
      });
      return;
    }

    const controller = new AbortController();
    const flight: Flight = {
      controller,
      done: false,
      aborted: false,
      cancelled: false,
      timer: null,
      active: true,
    };
    this.#flightsOf(instance.id).set(key, flight);
    const listeners = (): Set<EmitListener> => this.#listeners.get(instance.id) ?? new Set();
    const ctx: HandlerContext = {
      key,
      kind: request.kind,
      args: request.args,
      attempt: effect.attempt,
      signal: controller.signal,
      emit: (delta) => {
        if (flight.done || this.#closed || !isJson(delta)) return;
        for (const listener of listeners()) listener(key, delta);
      },
      secrets: {
        get: (name) => {
          const value = this.#secrets[name];
          return value === undefined
            ? Promise.reject(new Error(`secret ${name} is not set`))
            : Promise.resolve(value);
        },
      },
      log: { list: (query) => Promise.resolve(this.#list(instance.id, query ?? {})) },
    };

    const timeoutMs = handler.timeoutMs ?? this.#timeoutMs;
    if (timeoutMs !== undefined) {
      flight.timer = setTimeout(() => {
        controller.abort();
        this.#finish(instance.id, key, request.kind, flight, {
          failed: { code: 'timeout', error: { timeoutMs } },
        });
      }, timeoutMs);
    }
    Promise.resolve()
      .then(() => handler.run(ctx))
      .then(
        (value: unknown) =>
          this.#finish(
            instance.id,
            key,
            request.kind,
            flight,
            isJson(value)
              ? { ok: value }
              : { failed: { code: 'invalid_result', error: 'the result is not plain Json' } },
          ),
        (error: unknown) =>
          this.#finish(instance.id, key, request.kind, flight, {
            failed: { code: flight.aborted ? 'aborted' : 'threw', error: thrownToJson(error) },
          }),
      );
  }

  #startTimer(instance: StoredInstance, key: string, args: Json): void {
    const at =
      typeof args === 'object' && args !== null && !Array.isArray(args) ? args['at'] : undefined;
    if (typeof at !== 'number') {
      this.#report(instance.id, key, '@timer', {
        failed: { code: 'threw', error: '@timer needs { at }' },
      });
      return;
    }
    const flight: Flight = {
      controller: new AbortController(),
      done: false,
      aborted: false,
      cancelled: false,
      timer: null,
      active: false,
    };
    this.#flightsOf(instance.id).set(key, flight);
    flight.timer = setTimeout(
      () => this.#finish(instance.id, key, '@timer', flight, { ok: null }),
      Math.max(0, at - this.#clock()),
    );
  }

  /** A run ended: report its outcome, unless it was cancelled or the runner closed. */
  #finish(instanceId: string, key: string, kind: string, flight: Flight, outcome: Outcome): void {
    if (flight.done || this.#closed) return;
    flight.done = true;
    if (flight.timer !== null) clearTimeout(flight.timer);
    if (flight.cancelled) return;
    this.#report(instanceId, key, kind, outcome);
  }

  #report(instanceId: string, key: string, kind: string, outcome: Outcome): void {
    // The union variant for the effect's kind is chosen at runtime.
    const message = { type: 'effect', key, kind, outcome } as EffectMessage;
    this.#enqueue(instanceId, { kind: 'message', message, reported: key, answer: () => undefined });
  }

  // ---- recovery -------------------------------------------------------------

  #recover(instance: StoredInstance, registered: Registered): void {
    let list;
    try {
      list =
        registered.agent.effects?.(
          this.#state(registered, instance.snapshot, instance.log, instance.config),
        ) ?? [];
    } catch (error) {
      instance.fault = `effects failed during recovery: ${JSON.stringify(thrownToJson(error))}`;
      return;
    }
    const declared = new Set(list.map((request) => request.key));
    const reports: { key: string; kind: string; outcome: Outcome }[] = [];
    for (const [key, effect] of instance.effects) {
      const { kind } = effect.request;
      if (!declared.has(key)) {
        instance.effects.delete(key);
        instance.finished.add(key);
      } else if (kind === '@timer') {
        this.#startTimer(instance, key, effect.request.args);
      } else if (effect.mode === 'once') {
        reports.push({ key, kind, outcome: { interrupted: true } });
      } else if (
        effect.attempt + 1 >
        (registered.handlers[kind]?.maxAttempts ?? this.#maxAttempts)
      ) {
        reports.push({
          key,
          kind,
          outcome: { failed: { code: 'attempts_exhausted', error: { attempts: effect.attempt } } },
        });
      } else {
        instance.effects.set(key, { ...effect, attempt: effect.attempt + 1 });
        this.#start(instance, registered, key);
      }
    }
    // Reports go last: each one's step may change which effects are declared.
    for (const { key, kind, outcome } of reports) this.#report(instance.id, key, kind, outcome);
  }

  // ---- helpers --------------------------------------------------------------

  #instance(instanceId: string): StoredInstance {
    const instance = this.store.instances.get(instanceId);
    if (instance === undefined) throw new Error(`no instance ${instanceId}`);
    return instance;
  }

  #registered(agent: LoadedAgent): Registered {
    const registered = this.#agents.get(`${agent.name}@${agent.version}`);
    if (registered === undefined)
      throw new Error(`agent ${agent.name}@${agent.version} is not loaded`);
    return registered;
  }

  #flightsOf(instanceId: string): Map<string, Flight> {
    const flights = this.#flights.get(instanceId) ?? new Map<string, Flight>();
    this.#flights.set(instanceId, flights);
    return flights;
  }

  #list(instanceId: string, query: LogQuery): LogPage {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const matching = this.#instance(instanceId).log.filter(
      (entry) =>
        (query.after === undefined || entry.seq > query.after) &&
        (query.before === undefined || entry.seq < query.before) &&
        (query.kinds === undefined || query.kinds.includes(entry.kind)),
    );
    const limit = Math.min(query.limit ?? PAGE_SIZE, PAGE_SIZE);
    const entries = matching.slice(offset, offset + limit);
    const next = offset + entries.length;
    return next < matching.length ? { entries, cursor: String(next) } : { entries };
  }
}

/**
 * The runner treats an agent's snapshot, config and kinds as opaque Json:
 * it only ever hands an agent what that agent produced or what its callers
 * sent. So it holds every agent with those types erased.
 */
function erase<S extends JsonObject, C extends JsonObject, K extends Kinds>(
  agent: Agent<S, C, K>,
): Agent<JsonObject, JsonObject> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return agent as unknown as Agent<JsonObject, JsonObject>;
}
