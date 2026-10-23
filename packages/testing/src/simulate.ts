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
  readonly #agent: Agent<S, C, K>;
  #config: C;
  #snapshot: S;
  readonly #log: LogEntry[] = [];
  #now: number;
  #running = new Map<string, EffectRequest<K>>();
  readonly #finished = new Set<string>();
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
    assertJson(result.snapshot, 'init snapshot');
    this.#snapshot = deepFreeze(result.snapshot);
    this.#append(result.append ?? [], 'init append');
    this.#reconcile(null);
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
    const next = this.#log.length + 1;
    const asked = this.#agent.window?.(this.#snapshot) ?? 1;
    const start = Math.min(Math.max(Math.floor(asked), 1), next);
    return {
      snapshot: this.#snapshot,
      log: { start, next, entries: this.#log.slice(start - 1) },
      config: this.#config,
    };
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
    this.#running.delete(key);
    this.#finished.add(key);
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

  /** Changes the config, as a `config` message. */
  configure(config: C): Delivery<K> {
    const delivery = this.send({ type: 'config', config });
    if (delivery.rejected === null) this.#config = deepFreeze(structuredClone(config));
    return delivery;
  }

  /** Delivers any message to step. Use `configure` for a config change, so the config is kept. */
  send(message: Message<K>, reported: string | null = null): Delivery<K> {
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
    assertJson(result.snapshot, 'step snapshot');
    this.#snapshot = deepFreeze(result.snapshot);
    const appended = this.#append(result.append ?? [], 'step append');
    return { rejected: null, appended, ...this.#reconcile(reported) };
  }

  #append(entries: readonly { kind: string; body: Json }[], where: string): LogEntry[] {
    const appended: LogEntry[] = [];
    for (const { kind, body } of entries) {
      assertJson(body, `${where} ${kind}`);
      const entry = deepFreeze({ seq: this.#log.length + 1, at: this.#now, kind, body });
      this.#log.push(entry);
      appended.push(entry);
    }
    return appended;
  }

  #reconcile(reported: string | null): Omit<Delivery<K>, 'rejected' | 'appended'> {
    const list = this.#agent.effects?.(this.state()) ?? [];
    const seen = new Set<string>();
    const running = new Map<string, EffectRequest<K>>();
    const started: EffectRequest<K>[] = [];
    const aborted: string[] = [];
    for (const request of list) {
      if (seen.has(request.key))
        throw new SimulationError(`effect ${request.key} is declared twice`);
      seen.add(request.key);
      if (this.#finished.has(request.key)) continue;
      const previous = this.#running.get(request.key);
      if (previous) {
        const abort = request.abort === true && previous.abort !== true;
        if (abort) aborted.push(request.key);
        running.set(request.key, abort ? { ...previous, abort: true } : previous);
      } else {
        assertJson(request, `effect ${request.key}`);
        const frozen = deepFreeze(structuredClone(request));
        running.set(request.key, frozen);
        started.push(frozen);
      }
    }
    const cancelled: string[] = [];
    for (const key of this.#running.keys()) {
      if (!running.has(key) && key !== reported) {
        cancelled.push(key);
        this.#finished.add(key);
      }
    }
    this.#running = running;
    return { started, cancelled, aborted };
  }
}
