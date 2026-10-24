// The memory runner: runs agents' sessions in this process, following
// RUNNERS.md, and keeps their state in a memory store.
//
// Each session has a mailbox. Messages are taken one at a time: the step
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
  JournalAnswer,
  JournalEntry,
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

import { journalDigest } from '@acentric/replay';

import { deepFreeze, frozenCopy, isJson, requireJson, thrownToJson } from './json.js';
import { createMemoryStore } from './store.js';
import type { MemoryStore, StoredEffect, StoredSession } from './store.js';

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

  // ---- sessions ------------------------------------------------------------

  /** Creates a session, running init. Its id defaults to 'session-1', 'session-2', ... */
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
    const session: StoredSession = {
      id: id ?? `session-${this.store.created}`,
      agent: { name: agent.name, version: agent.version },
      config: frozenCopy(config),
      snapshot: {},
      log: [],
      effects: new Map(),
      finished: new Set(),
      fault: null,
      journal: [],
    };
    let prepared;
    try {
      prepared = this.#prepare(
        session,
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
    this.store.sessions.set(session.id, session);
    this.#apply(session, prepared);
    session.journal.push(
      deepFreeze({
        n: 1,
        type: 'init',
        version: agent.version,
        now,
        config: session.config,
        digest: journalDigest(session.snapshot, session.config, prepared.entries),
      }),
    );
    this.#act(session, registered, prepared);
    return { accepted: true, id: session.id };
  }

  /** Sends an input, answering once its step is saved. The id defaults to a new one. */
  input(sessionId: string, kind: string, payload: JsonObject, inputId?: string): Promise<Answer> {
    const id = inputId ?? globalThis.crypto.randomUUID();
    return this.#send(sessionId, { type: 'input', id, kind, payload });
  }

  /** Changes a session's config, answering once its step is saved. */
  configure(sessionId: string, config: JsonObject): Promise<Answer> {
    return this.#send(sessionId, { type: 'config', config });
  }

  /** Moves a session onto another loaded version of its agent, between steps. */
  upgrade(sessionId: string, agent: LoadedAgent): Promise<Answer> {
    return new Promise((answer) => {
      this.#enqueue(sessionId, { kind: 'upgrade', agent, answer });
    });
  }

  snapshot(sessionId: string): JsonObject {
    return this.#session(sessionId).snapshot;
  }

  config(sessionId: string): JsonObject {
    return this.#session(sessionId).config;
  }

  /** The whole log, oldest first. */
  log(sessionId: string): readonly LogEntry[] {
    return this.#session(sessionId).log;
  }

  /** What the agent's view shows, or null if it has none. */
  view(sessionId: string): Json {
    const session = this.#session(sessionId);
    const registered = this.#registered(session.agent);
    return (
      registered.agent.view?.(
        this.#state(registered, session.snapshot, session.log, session.config),
      ) ?? null
    );
  }

  /** The session's declared, unfinished effects, in the order they started. */
  running(sessionId: string): RunningEffect[] {
    const session = this.#session(sessionId);
    const flights = this.#flights.get(sessionId);
    return [...session.effects.values()].map(({ request, attempt }) => {
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

  /** Why the session stopped taking messages, or null if it has not. */
  fault(sessionId: string): string | null {
    return this.#session(sessionId).fault;
  }

  /** Everything the session received, oldest first, for replaying it. */
  journal(sessionId: string): readonly JournalEntry[] {
    return this.#session(sessionId).journal;
  }

  /**
   * Forks a session at journal entry `at`, the newest by default: a new
   * session with the state the original had after that entry, on the
   * version that ran it. Effects that had finished stay finished; effects
   * that were running start again as after a crash, at attempt 1, and once
   * effects are reported interrupted. Fails if replaying the journal does
   * not give the digests it recorded.
   */
  fork(sessionId: string, options: { at?: number; id?: string } = {}): Answer & { id?: string } {
    const source = this.#session(sessionId);
    const at = options.at ?? source.journal.length;
    if (!Number.isInteger(at) || at < 1 || at > source.journal.length) {
      return { failed: `session ${sessionId} has no journal entry ${at}` };
    }
    this.store.created += 1;
    const id = options.id ?? `session-${this.store.created}`;
    if (this.store.sessions.has(id)) return { failed: `session ${id} already exists` };
    let session;
    try {
      session = this.#replay(id, source.agent.name, source.journal.slice(0, at));
    } catch (error) {
      return { failed: thrownToJson(error) };
    }
    this.store.sessions.set(id, session);
    this.#recover(session, this.#registered(session.agent), 'first');
    return { accepted: true, id };
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Recovers every stored session whose agent is loaded, as after a crash:
   * effects are matched again, reissue effects that were running run again
   * with the next attempt, once effects that were running are reported
   * interrupted, and timers are scheduled again.
   */
  start(): void {
    for (const session of this.store.sessions.values()) {
      const registered = this.#agents.get(`${session.agent.name}@${session.agent.version}`);
      if (registered !== undefined && session.fault === null) this.#recover(session, registered);
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

  #send(sessionId: string, message: Message): Promise<Answer> {
    return new Promise((answer) => {
      this.#enqueue(sessionId, { kind: 'message', message, reported: null, answer });
    });
  }

  #enqueue(sessionId: string, job: Job): void {
    if (this.#closed) {
      job.answer({ failed: 'the runner is closed' });
      return;
    }
    const mailbox = this.#mailboxes.get(sessionId) ?? [];
    mailbox.push(job);
    this.#mailboxes.set(sessionId, mailbox);
    this.#drain(sessionId);
  }

  /** Takes jobs one at a time. A job started while draining waits its turn. */
  #drain(sessionId: string): void {
    if (this.#draining.has(sessionId)) return;
    this.#draining.add(sessionId);
    try {
      const mailbox = this.#mailboxes.get(sessionId) ?? [];
      for (let job = mailbox.shift(); job !== undefined; job = mailbox.shift()) {
        job.answer(this.#run(sessionId, job));
      }
    } finally {
      this.#draining.delete(sessionId);
    }
  }

  #run(sessionId: string, job: Job): Answer {
    if (this.#closed) return { failed: 'the runner is closed' };
    const session = this.store.sessions.get(sessionId);
    if (session === undefined) return { failed: `no session ${sessionId}` };
    if (session.fault !== null) return { failed: `the session has stopped: ${session.fault}` };
    if (job.kind === 'upgrade') return this.#upgrade(session, job.agent);
    // A result can wait in the mailbox while a step before it cancels its
    // key. The result is then discarded, like any cancelled effect's.
    if (job.reported !== null && !session.effects.has(job.reported)) return { accepted: true };
    return this.#deliver(session, this.#registered(session.agent), job.message, job.reported);
  }

  #deliver(
    session: StoredSession,
    registered: Registered,
    message: Message,
    reported: string | null,
  ): Answer {
    const now = this.#now(session);
    const { answer, prepared } = this.#step(session, registered, message, reported, now);
    if (prepared !== null) this.#apply(session, prepared);
    else if ('failed' in answer) this.#stepFailed(session, message, answer.failed);
    session.journal.push(
      deepFreeze({
        n: session.journal.length + 1,
        type: 'step',
        version: session.agent.version,
        now,
        message: frozenCopy(message),
        answer: answerOf(answer),
        ...(prepared === null
          ? {}
          : { digest: journalDigest(session.snapshot, session.config, prepared.entries) }),
      }),
    );
    if (prepared !== null) this.#act(session, registered, prepared);
    return answer;
  }

  /** Runs one step and checks its result, changing nothing. */
  #step(
    session: StoredSession,
    registered: Registered,
    message: Message,
    reported: string | null,
    now: number,
  ): { answer: Answer; prepared: Prepared | null } {
    const state = this.#state(registered, session.snapshot, session.log, session.config);
    let result;
    try {
      result = registered.agent.step(state, frozenCopy(message), now);
    } catch (error) {
      return { answer: { failed: thrownToJson(error) }, prepared: null };
    }
    if ('error' in result) {
      if (message.type === 'input' || message.type === 'config') {
        const answer: Answer = isJson(result.error)
          ? { rejected: result.error }
          : { failed: 'the rejection is not plain Json' };
        return { answer, prepared: null };
      }
      return { answer: { failed: `step rejected a ${message.type} message` }, prepared: null };
    }
    const config = message.type === 'config' ? message.config : session.config;
    try {
      const prepared = this.#prepare(
        session,
        registered,
        result.snapshot,
        result.append ?? [],
        config,
        reported,
        now,
      );
      return { answer: { accepted: true }, prepared };
    } catch (error) {
      return { answer: { failed: thrownToJson(error) }, prepared: null };
    }
  }

  /**
   * A failed step applies nothing. A caller's input or config change is
   * answered with the failure and dropped; any other message stops the
   * session, since a pure step would fail the same way again.
   */
  #stepFailed(session: StoredSession, message: Message, error: Json): void {
    if (message.type !== 'input' && message.type !== 'config') {
      session.fault = `a ${message.type} message's step failed: ${JSON.stringify(error)}`;
    }
  }

  #upgrade(session: StoredSession, agent: LoadedAgent): Answer {
    const registered = this.#registered(agent);
    const from = session.agent.version;
    const now = this.#now(session);
    const { answer, prepared } = this.#migrate(session, registered, now);
    if (prepared === null) return answer;
    session.agent = { name: agent.name, version: agent.version };
    this.#apply(session, prepared);
    session.journal.push(
      deepFreeze({
        n: session.journal.length + 1,
        type: 'upgrade',
        version: agent.version,
        from,
        now,
        digest: journalDigest(session.snapshot, session.config, []),
      }),
    );
    this.#act(session, registered, prepared);
    this.#deliver(session, registered, { type: 'migrated', from }, null);
    return { accepted: true };
  }

  /** Runs the new version's migrate and checks its result, changing nothing. */
  #migrate(
    session: StoredSession,
    registered: Registered,
    now: number,
  ): { answer: Answer; prepared: Prepared | null } {
    let snapshot = session.snapshot;
    let config = session.config;
    const migrate = registered.agent.migrate;
    if (migrate !== undefined) {
      let result;
      try {
        result = migrate(session.snapshot, session.config, session.agent.version);
      } catch (error) {
        return { answer: { failed: thrownToJson(error) }, prepared: null };
      }
      if ('error' in result) {
        return { answer: { rejected: requireJson(result.error, 'the rejection') }, prepared: null };
      }
      snapshot = result.snapshot;
      config = result.config ?? config;
    }
    try {
      const prepared = this.#prepare(session, registered, snapshot, [], config, null, now);
      return { answer: { accepted: true }, prepared };
    } catch (error) {
      return { answer: { failed: thrownToJson(error) }, prepared: null };
    }
  }

  /**
   * Builds a session from journal entries, as their steps left it, starting
   * no effects. Throws if an entry's code is not loaded or it does not leave
   * the digest the journal recorded.
   */
  #replay(id: string, name: string, entries: readonly JournalEntry[]): StoredSession {
    const [first, ...rest] = entries;
    if (first?.type !== 'init') throw new Error('a journal starts with its init entry');
    let registered = this.#registered({ name, version: first.version });
    const result = registered.agent.init(frozenCopy(first.config), first.now);
    if ('error' in result) throw new Error('init rejected the config the journal recorded');
    const session: StoredSession = {
      id,
      agent: { name, version: first.version },
      config: frozenCopy(first.config),
      snapshot: {},
      log: [],
      effects: new Map(),
      finished: new Set(),
      fault: null,
      journal: [...entries],
    };
    const replayed = (entry: JournalEntry, prepared: Prepared | null): void => {
      if (prepared === null) throw new Error(`journal entry ${entry.n} no longer applies`);
      this.#apply(session, prepared);
      const digest = journalDigest(session.snapshot, session.config, prepared.entries);
      if (digest !== entry.digest) throw new Error(`journal entry ${entry.n} gives another digest`);
    };
    replayed(
      first,
      this.#prepare(
        session,
        registered,
        result.snapshot,
        result.append ?? [],
        first.config,
        null,
        first.now,
      ),
    );
    for (const entry of rest) {
      if (entry.type === 'init') throw new Error(`journal entry ${entry.n} is a second init`);
      if (entry.type === 'upgrade') {
        registered = this.#registered({ name, version: entry.version });
        const { prepared } = this.#migrate(session, registered, entry.now);
        session.agent = { name, version: entry.version };
        replayed(entry, prepared);
      } else if (entry.answer === 'accepted') {
        const { message } = entry;
        const reported = message.type === 'effect' ? message.key : null;
        replayed(entry, this.#step(session, registered, message, reported, entry.now).prepared);
      }
    }
    return session;
  }

  // ---- checking and applying a step -----------------------------------------

  /** `now` for a step: the clock, but never earlier than the session's newest entry. */
  #now(session: StoredSession): number {
    return Math.max(this.#clock(), session.log.at(-1)?.at ?? 0);
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
    session: StoredSession,
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
        seq: session.log.length + 1 + index,
        at: now,
        kind,
        body: structuredClone(requireJson(body, `the body of a ${kind} entry`)),
      });
    });
    const frozenSnapshot = frozenCopy(snapshot);
    const state = this.#state(registered, frozenSnapshot, [...session.log, ...entries], config);
    if (registered.agent.view !== undefined) requireJson(registered.agent.view(state), 'the view');
    const list = registered.agent.effects?.(state) ?? [];

    const finished = new Set(session.finished);
    const previous = new Map(session.effects);
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

  #apply(session: StoredSession, prepared: Prepared): void {
    session.snapshot = prepared.snapshot;
    session.config = prepared.config;
    session.log.push(...prepared.entries);
    session.effects = prepared.effects;
    session.finished = prepared.finished;
  }

  /** After a step is applied: cancel, abort and start effects. */
  #act(session: StoredSession, registered: Registered, prepared: Prepared): void {
    const flights = this.#flightsOf(session.id);
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
    for (const key of prepared.started) this.#start(session, registered, key);
  }

  #mode(registered: Registered, kind: string): Mode {
    return registered.handlers[kind]?.mode ?? 'reissue';
  }

  // ---- running effects ------------------------------------------------------

  #start(session: StoredSession, registered: Registered, key: string): void {
    const effect = session.effects.get(key);
    if (effect === undefined) return;
    const { request } = effect;
    if (request.kind === '@timer') {
      this.#startTimer(session, key, request.args);
      return;
    }
    const handler = request.kind.startsWith('@') ? undefined : registered.handlers[request.kind];
    if (handler === undefined) {
      this.#report(session.id, key, request.kind, {
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
    this.#flightsOf(session.id).set(key, flight);
    const ctx: HandlerContext = {
      key,
      kind: request.kind,
      args: request.args,
      attempt: effect.attempt,
      signal: controller.signal,
      secrets: {
        get: (name) => {
          const value = this.#secrets[name];
          return value === undefined
            ? Promise.reject(new Error(`secret ${name} is not set`))
            : Promise.resolve(value);
        },
      },
      log: { list: (query) => Promise.resolve(this.#list(session.id, query ?? {})) },
    };

    const timeoutMs = handler.timeoutMs ?? this.#timeoutMs;
    if (timeoutMs !== undefined) {
      flight.timer = setTimeout(() => {
        controller.abort();
        this.#finish(session.id, key, request.kind, flight, {
          failed: { code: 'timeout', error: { timeoutMs } },
        });
      }, timeoutMs);
    }
    Promise.resolve()
      .then(() => handler.run(ctx))
      .then(
        (value: unknown) =>
          this.#finish(
            session.id,
            key,
            request.kind,
            flight,
            isJson(value)
              ? { ok: value }
              : { failed: { code: 'invalid_result', error: 'the result is not plain Json' } },
          ),
        (error: unknown) =>
          this.#finish(session.id, key, request.kind, flight, {
            failed: { code: flight.aborted ? 'aborted' : 'threw', error: thrownToJson(error) },
          }),
      );
  }

  #startTimer(session: StoredSession, key: string, args: Json): void {
    const at =
      typeof args === 'object' && args !== null && !Array.isArray(args) ? args['at'] : undefined;
    if (typeof at !== 'number') {
      this.#report(session.id, key, '@timer', {
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
    this.#flightsOf(session.id).set(key, flight);
    flight.timer = setTimeout(
      () => this.#finish(session.id, key, '@timer', flight, { ok: null }),
      Math.max(0, at - this.#clock()),
    );
  }

  /** A run ended: report its outcome, unless it was cancelled or the runner closed. */
  #finish(sessionId: string, key: string, kind: string, flight: Flight, outcome: Outcome): void {
    if (flight.done || this.#closed) return;
    flight.done = true;
    if (flight.timer !== null) clearTimeout(flight.timer);
    if (flight.cancelled) return;
    this.#report(sessionId, key, kind, outcome);
  }

  #report(sessionId: string, key: string, kind: string, outcome: Outcome): void {
    // The union variant for the effect's kind is chosen at runtime.
    const message = { type: 'effect', key, kind, outcome } as EffectMessage;
    this.#enqueue(sessionId, { kind: 'message', message, reported: key, answer: () => undefined });
  }

  // ---- recovery -------------------------------------------------------------

  /**
   * Starts a stored session's effects again. After a crash, a reissue effect
   * runs at its next attempt; in a new fork, `attempts: 'first'` keeps it at
   * its first.
   */
  #recover(
    session: StoredSession,
    registered: Registered,
    attempts: 'next' | 'first' = 'next',
  ): void {
    let list;
    try {
      list =
        registered.agent.effects?.(
          this.#state(registered, session.snapshot, session.log, session.config),
        ) ?? [];
    } catch (error) {
      session.fault = `effects failed during recovery: ${JSON.stringify(thrownToJson(error))}`;
      return;
    }
    const declared = new Set(list.map((request) => request.key));
    const reports: { key: string; kind: string; outcome: Outcome }[] = [];
    for (const [key, effect] of session.effects) {
      const { kind } = effect.request;
      if (!declared.has(key)) {
        session.effects.delete(key);
        session.finished.add(key);
      } else if (kind === '@timer') {
        this.#startTimer(session, key, effect.request.args);
      } else if (effect.mode === 'once') {
        reports.push({ key, kind, outcome: { interrupted: true } });
      } else if (attempts === 'first') {
        this.#start(session, registered, key);
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
        session.effects.set(key, { ...effect, attempt: effect.attempt + 1 });
        this.#start(session, registered, key);
      }
    }
    // Reports go last: each one's step may change which effects are declared.
    for (const { key, kind, outcome } of reports) this.#report(session.id, key, kind, outcome);
  }

  // ---- helpers --------------------------------------------------------------

  #session(sessionId: string): StoredSession {
    const session = this.store.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    return session;
  }

  #registered(agent: LoadedAgent): Registered {
    const registered = this.#agents.get(`${agent.name}@${agent.version}`);
    if (registered === undefined)
      throw new Error(`agent ${agent.name}@${agent.version} is not loaded`);
    return registered;
  }

  #flightsOf(sessionId: string): Map<string, Flight> {
    const flights = this.#flights.get(sessionId) ?? new Map<string, Flight>();
    this.#flights.set(sessionId, flights);
    return flights;
  }

  #list(sessionId: string, query: LogQuery): LogPage {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const matching = this.#session(sessionId).log.filter(
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

/** How step answered, as a journal records it. */
function answerOf(answer: Answer): JournalAnswer {
  if ('accepted' in answer) return 'accepted';
  return 'rejected' in answer ? 'rejected' : 'failed';
}
