// Runs an agent's pure half in memory, for tests.
//
// A simulation keeps an agent's snapshot, log and config, delivers messages
// to its step one at a time, and matches the effects it declares the way a
// runner would: new keys start, missing keys are cancelled, a newly set
// `abort` aborts, finished keys are never run again. It runs no handlers.
// The test plays them, delivering each effect's outcome by hand, and plays
// the clock with `advance`.
//
// It checks what a runner would: outputs are plain Json, the state given to
// step is frozen, a key appears once per list, and an effect or migrated
// message is never rejected.

import type {
  Agent,
  EffectMessage,
  EffectRequest,
  Failure,
  Json,
  JsonObject,
  Kinds,
  LogEntry,
  Message,
  NoConfig,
  Outcome,
  State,
} from '@acentric/types';

import { assertJson, deepFreeze } from './json.js';

/** What delivering one message did. */
export type Delivery<K extends Kinds> = {
  /** Why step rejected the message, or null if it accepted it. */
  rejected: Json | null;
  /** The log entries the step appended. */
  appended: LogEntry[];
  /** Effects that started. */
  started: EffectRequest<K>[];
  /** Keys of effects that were cancelled: they will never report. */
  cancelled: string[];
  /** Keys of running effects that were newly marked `abort`. */
  aborted: string[];
};

/** Thrown when an agent does something no runner would accept. */
export class SimulationError extends Error {
  override name = 'SimulationError';
}

export type SimulateOptions = {
  /** The clock at the start, in milliseconds. Defaults to 0. */
  now?: number;
};

/**
 * Creates the agent with `config` and returns its simulation. Throws a
 * SimulationError if init rejects the config.
 */
export function simulate<
  S extends JsonObject,
  C extends JsonObject = NoConfig,
  K extends Kinds = Kinds,
>(agent: Agent<S, C, K>, config: C, options: SimulateOptions = {}): Simulation<S, C, K> {
  return new Simulation(agent, config, options.now ?? 0);
}

export class Simulation<S extends JsonObject, C extends JsonObject, K extends Kinds> {
  #agent: Agent<S, C, K>;
  #config: C;
  #snapshot: S;
  readonly #log: LogEntry[] = [];
  #now: number;
  #running = new Map<string, EffectRequest<K>>();
  #finished = new Set<string>();
  #inputs = 0;

  constructor(agent: Agent<S, C, K>, config: C, now: number) {
    this.#agent = agent;
    this.#now = now;
    assertJson(config, 'config');
    this.#config = deepFreeze(structuredClone(config));
    const result = agent.init(this.#config, now);
    if ('error' in result) {
      throw new SimulationError(`init rejected the config: ${JSON.stringify(result.error)}`);
    }
    const prepared = this.#prepare(result.snapshot, result.append ?? [], null, 'init');
    this.#snapshot = prepared.snapshot;
    this.#apply(prepared);
  }

  get snapshot(): S {
    return this.#snapshot;
  }

  get config(): C {
    return this.#config;
  }

  /** The whole log, oldest first. */
  get log(): readonly LogEntry[] {
    return this.#log;
  }

  get now(): number {
    return this.#now;
  }

  /** Effects declared and not yet reported, cancelled or finished, in the order they started. */
  get running(): EffectRequest<K>[] {
    return [...this.#running.values()];
  }

  /** Keys of effects that finished or were cancelled: they never run again. */
  get finished(): string[] {
    return [...this.#finished];
  }

  /** The running effect with this key. Throws if there is none. */
  effect(key: string): EffectRequest<K> {
    const request = this.#running.get(key);
    if (!request) throw new SimulationError(`no effect ${key} is running`);
    return request;
  }

  /** The running effects of one kind, in the order they started, typed by that kind. */
  effectsOf<N extends keyof K & string>(kind: N): Extract<EffectRequest<K>, { kind: N }>[] {
    return this.running.filter(
      (request): request is Extract<EffectRequest<K>, { kind: N }> => request.kind === kind,
    );
  }

  /** The state a step would see now, with the log window the agent asks for. */
  state(): State<S, C> {
    return this.#stateOf(this.#snapshot, this.#log);
  }

  /** Moves the clock forward. */
  advance(ms: number): void {
    this.#now += ms;
  }

  /** Delivers an input, as a caller would. The id defaults to 'in-1', 'in-2', ... */
  input(kind: string, payload: JsonObject, id?: string): Delivery<K> {
    this.#inputs += 1;
    return this.send({ type: 'input', id: id ?? `in-${this.#inputs}`, kind, payload });
  }

  /** Delivers a running effect's outcome. */
  report(key: string, outcome: Outcome): Delivery<K> {
    const request = this.effect(key);
    // The union variant for this request's kind is chosen at runtime.
    const message = { type: 'effect', key, kind: request.kind, outcome } as EffectMessage<K>;
    return this.send(message, key);
  }

  /** Reports that a running effect returned `value`. */
  ok(key: string, value: Json): Delivery<K> {
    return this.report(key, { ok: value });
  }

  /** Reports that a running effect failed. */
  fail(key: string, code: Failure['code'], error: Json = null): Delivery<K> {
    return this.report(key, { failed: { code, error } });
  }

  /** Reports that a running 'once' effect was cut off by a crash. */
  interrupt(key: string): Delivery<K> {
    return this.report(key, { interrupted: true });
  }

  /**
   * Changes the config, as a `config` message. As in a runner, the step sees
   * the current config, and the new one applies if it accepts.
   */
  configure(config: C): Delivery<K> {
    assertJson(config, 'config');
    return this.#deliver({ type: 'config', config }, null, deepFreeze(structuredClone(config)));
  }

  /**
   * Delivers any message to step. Use `configure` for a config change, so
   * the config is kept. A step that throws, returns something that is not
   * Json, or names an effect key twice changes nothing.
   */
  send(message: Message<K>, reported: string | null = null): Delivery<K> {
    return this.#deliver(message, reported, this.#config);
  }

  /**
   * Moves the session to another version of the agent's code, as a runner's
   * upgrade does: the new version's migrate converts the snapshot and config,
   * effects are matched again, and `migrated` is delivered, unless
   * `migrated: false`. Returns this simulation, now of the new version.
   * Throws a SimulationError if migrate rejects, leaving it unchanged.
   */
  upgrade<S2 extends JsonObject, C2 extends JsonObject = NoConfig, K2 extends Kinds = Kinds>(
    next: Agent<S2, C2, K2>,
    options: { migrated?: boolean } = {},
  ): Simulation<S2, C2, K2> {
    const from = this.#agent.version;
    const migrated = next.migrate?.(this.#snapshot, this.#config, from);
    if (migrated !== undefined && 'error' in migrated) {
      throw new SimulationError(`migrate rejected the upgrade: ${JSON.stringify(migrated.error)}`);
    }
    // The same simulation goes on as the new version, with its types.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const upgraded = this as unknown as Simulation<S2, C2, K2>;
    // Without migrate, or without a config from it, the stored values carry over.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const snapshot = (migrated?.snapshot ?? this.#snapshot) as S2;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const config = (migrated?.config ?? this.#config) as C2;
    assertJson(config, 'migrate config');
    const before = this.#agent;
    upgraded.#agent = next;
    try {
      upgraded.#apply(
        upgraded.#prepare(snapshot, [], null, 'migrate', deepFreeze(structuredClone(config))),
      );
    } catch (error) {
      this.#agent = before;
      throw error;
    }
    if (options.migrated !== false) upgraded.send({ type: 'migrated', from });
    return upgraded;
  }

  #deliver(message: Message<K>, reported: string | null, config: C): Delivery<K> {
    assertJson(message, 'message');
    const frozen = deepFreeze(structuredClone(message));
    const result = this.#agent.step(this.state(), frozen, this.#now);
    if ('error' in result) {
      if (message.type === 'effect' || message.type === 'migrated') {
        throw new SimulationError(`step rejected a ${message.type} message, which is a bug`);
      }
      assertJson(result.error, 'rejection');
      return { rejected: result.error, appended: [], started: [], cancelled: [], aborted: [] };
    }
    const prepared = this.#prepare(result.snapshot, result.append ?? [], reported, 'step', config);
    this.#apply(prepared);
    const { entries, started, cancelled, aborted } = prepared;
    return { rejected: null, appended: entries, started, cancelled, aborted };
  }

  /** The state a step would see with this snapshot, log and config. */
  #stateOf(snapshot: S, log: readonly LogEntry[], config: C = this.#config): State<S, C> {
    const next = log.length + 1;
    const asked = this.#agent.window?.(snapshot) ?? 1;
    const start = Math.min(Math.max(Math.floor(asked), 1), next);
    return { snapshot, log: { start, next, entries: log.slice(start - 1) }, config };
  }

  /**
   * Checks everything a step's result leads to, changing nothing: the
   * snapshot, the appended entries, and the effects that should then exist,
   * matched against those running.
   */
  #prepare(
    snapshot: S,
    append: readonly { kind: string; body: Json }[],
    reported: string | null,
    where: string,
    config: C = this.#config,
  ): Prepared<S, C, K> {
    assertJson(snapshot, `${where} snapshot`);
    const entries = append.map(({ kind, body }, index) => {
      assertJson(body, `${where} append ${kind}`);
      return deepFreeze({ seq: this.#log.length + 1 + index, at: this.#now, kind, body });
    });
    const state = this.#stateOf(snapshot, [...this.#log, ...entries], config);
    if (this.#agent.view) assertJson(this.#agent.view(state), `${where} view`);
    const list = this.#agent.effects?.(state) ?? [];

    const finished = new Set(this.#finished);
    const previous = new Map(this.#running);
    if (reported !== null) {
      previous.delete(reported);
      finished.add(reported);
    }
    const seen = new Set<string>();
    const running = new Map<string, EffectRequest<K>>();
    const started: EffectRequest<K>[] = [];
    const aborted: string[] = [];
    for (const request of list) {
      if (seen.has(request.key))
        throw new SimulationError(`effect ${request.key} is declared twice`);
      seen.add(request.key);
      if (finished.has(request.key)) continue;
      const before = previous.get(request.key);
      if (before) {
        const abort = request.abort === true && before.abort !== true;
        if (abort) aborted.push(request.key);
        running.set(request.key, abort ? { ...before, abort: true } : before);
      } else {
        assertJson(request, `effect ${request.key}`);
        const frozen = deepFreeze(structuredClone(request));
        running.set(request.key, frozen);
        started.push(frozen);
      }
    }
    const cancelled = [...previous.keys()].filter((key) => !running.has(key));
    for (const key of cancelled) finished.add(key);
    return {
      snapshot: deepFreeze(snapshot),
      config,
      entries,
      running,
      finished,
      started,
      cancelled,
      aborted,
    };
  }

  #apply(prepared: Prepared<S, C, K>): void {
    this.#snapshot = prepared.snapshot;
    this.#config = prepared.config;
    this.#log.push(...prepared.entries);
    this.#running = prepared.running;
    this.#finished = prepared.finished;
  }
}

/** A step's result, checked and ready to apply. */
type Prepared<S extends JsonObject, C extends JsonObject, K extends Kinds> = {
  snapshot: S;
  config: C;
  entries: LogEntry[];
  running: Map<string, EffectRequest<K>>;
  finished: Set<string>;
  started: EffectRequest<K>[];
  cancelled: string[];
  aborted: string[];
};
