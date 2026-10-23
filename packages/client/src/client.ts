// A connection to a runner, over any transport: typed methods for the
// protocol's requests, subscriptions that deliver a session's
// notifications, and handlers for the kinds this application provides.

import { PROTOCOL_VERSION, RpcError, RpcPeer } from '@acentric/protocol';
import type {
  AgentRef,
  Answer,
  DeployParams,
  ErrorCode,
  SessionInfo,
  SessionListing,
  LogPageResult,
  RpcMessage,
  RunnerMethods,
  Status,
} from '@acentric/protocol';
import type { Json, JsonObject, LogEntry, LogPage, LogQuery } from '@acentric/types';

/** Carries messages between the client and a runner. */
export type Transport = {
  send(message: RpcMessage): void;
  /** Called once with a handler for every message that arrives. */
  receive(handler: (message: unknown) => void): void;
  /** Resolves when the transport has closed, for any reason. */
  closed: Promise<void>;
  close(): void;
};

/** What a handler the application provides receives. */
export type ProvidedContext = {
  session: string;
  key: string;
  kind: string;
  args: Json;
  attempt: number;
  /** Fires when the effect is cancelled or aborted. */
  signal: AbortSignal;
  emit(delta: Json): void;
  log: { list(query?: LogQuery): Promise<LogPage> };
};

/** A handler for a kind the application provides. A thrown error becomes the effect's failure. */
export type ProvidedHandler = (ctx: ProvidedContext) => Promise<Json>;

export type ClientOptions = {
  /** The client's name, shown by the runner. */
  name?: string;
  /** Handlers for kinds this application provides, by kind. */
  provides?: Record<string, ProvidedHandler>;
};

/** What a subscriber hears about a session. */
export type SessionEvent =
  | { type: 'log'; entries: LogEntry[] }
  | { type: 'view'; view: Json }
  | { type: 'status'; status: Status; fault: string | null }
  | { type: 'emit'; key: string; delta: Json };

export type Subscription = { close(): Promise<void> };

/** A request the runner refused, such as for an unknown session. `code` names the problem. */
export class RunnerRequestError extends Error {
  readonly code: ErrorCode | 'protocol';

  constructor(code: ErrorCode | 'protocol', message: string) {
    super(message);
    this.name = 'RunnerRequestError';
    this.code = code;
  }
}

type Method = keyof RunnerMethods;

export class RunnerClient {
  readonly #transport: Transport;
  readonly #peer: RpcPeer;
  readonly #provides: Record<string, ProvidedHandler>;
  readonly #listeners = new Map<string, (event: SessionEvent) => void>();
  readonly #running = new Map<string, AbortController>();
  #subscriptions = 0;

  /** Connects over `transport` and initializes the protocol. */
  static async open(transport: Transport, options: ClientOptions = {}): Promise<RunnerClient> {
    const client = new RunnerClient(transport, options);
    await client.#call('initialize', {
      client: options.name ?? 'acentric-client',
      protocolVersion: PROTOCOL_VERSION,
      provides: Object.keys(options.provides ?? {}),
    });
    return client;
  }

  private constructor(transport: Transport, options: ClientOptions) {
    this.#transport = transport;
    this.#provides = { ...options.provides };
    this.#peer = new RpcPeer((message) => transport.send(message), {
      request: (method, params) => this.#answer(method, params),
      notify: (method, params) => this.#notified(method, params),
    });
    transport.receive((message) => this.#peer.receive(message));
    void transport.closed.then(() => {
      this.#peer.close(new RunnerRequestError('closed', 'the connection to the runner closed'));
      for (const controller of this.#running.values()) controller.abort();
    });
  }

  /** Resolves when the connection has closed. */
  get closed(): Promise<void> {
    return this.#transport.closed;
  }

  // ---- agents ---------------------------------------------------------------

  /** Deploys an agent's code, as source or as paths the runner reads. */
  deploy(params: DeployParams): Promise<{ hash: string; deployed: boolean }> {
    return this.#call('agents/deploy', params);
  }

  async listAgents(): Promise<(AgentRef & { hash: string; sessions: number })[]> {
    return (await this.#call('agents/list', {})).agents;
  }

  setSecret(name: string, value: string): Promise<void> {
    return this.#call('secrets/set', { name, value }).then(() => undefined);
  }

  // ---- sessions ------------------------------------------------------------

  /** Creates a session; `agent` is a ref or 'name@version'. */
  create(
    agent: AgentRef | string,
    config: JsonObject,
    options: { id?: string } = {},
  ): Promise<Answer & { id?: string }> {
    return this.#call('sessions/create', { agent: toRef(agent), config, ...options });
  }

  input(id: string, input: { id?: string; kind: string; payload?: JsonObject }): Promise<Answer> {
    return this.#call('sessions/input', {
      id,
      input: {
        ...(input.id === undefined ? {} : { id: input.id }),
        kind: input.kind,
        payload: input.payload ?? {},
      },
    });
  }

  configure(id: string, config: JsonObject, requestId?: string): Promise<Answer> {
    return this.#call('sessions/configure', {
      id,
      config,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  upgrade(id: string, to: string): Promise<Answer> {
    return this.#call('sessions/upgrade', { id, to });
  }

  /** The session now; with `snapshot`, its snapshot too, for debugging. */
  get(id: string, options: { snapshot?: boolean } = {}): Promise<SessionInfo> {
    return this.#call('sessions/get', { id, ...options });
  }

  async list(filter: RunnerMethods['sessions/list']['params'] = {}): Promise<SessionListing[]> {
    return (await this.#call('sessions/list', filter)).sessions;
  }

  /** A page of the log. */
  log(id: string, query: LogQuery = {}): Promise<LogPageResult> {
    return this.#call('sessions/log', { id, ...query });
  }

  delete(id: string): Promise<void> {
    return this.#call('sessions/delete', { id }).then(() => undefined);
  }

  /**
   * Hears what happens to a session: the log after `after` first, then
   * each step as it is saved, with no gap, and emits if asked for.
   */
  async subscribe(
    id: string,
    options: { after?: number; emits?: boolean },
    listener: (event: SessionEvent) => void,
  ): Promise<Subscription> {
    this.#subscriptions += 1;
    const subscription = `s${this.#subscriptions}`;
    this.#listeners.set(subscription, listener);
    try {
      await this.#call('sessions/subscribe', { id, subscription, ...options });
    } catch (error) {
      this.#listeners.delete(subscription);
      throw error;
    }
    return {
      close: async () => {
        this.#listeners.delete(subscription);
        await this.#call('sessions/unsubscribe', { subscription });
      },
    };
  }

  /** Closes the connection. */
  close(): Promise<void> {
    this.#transport.close();
    return this.#transport.closed;
  }

  // ---- the protocol ---------------------------------------------------------

  async #call<M extends Method>(
    method: M,
    params: RunnerMethods[M]['params'],
  ): Promise<RunnerMethods[M]['result']> {
    try {
      const result = await this.#peer.request(method, params);
      // The runner answers each method with that method's result type.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return result as RunnerMethods[M]['result'];
    } catch (error) {
      if (error instanceof RpcError) {
        const data = error.data;
        const code =
          typeof data === 'object' && data !== null && !Array.isArray(data)
            ? data['code']
            : undefined;
        throw new RunnerRequestError(isErrorCode(code) ? code : 'protocol', error.message);
      }
      throw error;
    }
  }

  #notified(method: string, params: Json): void {
    if (!isObject(params)) return;
    if (method === 'effect/cancel') {
      this.#running.get(runKey(params['session'], params['key']))?.abort();
      return;
    }
    const subscription = params['subscription'];
    const listener =
      typeof subscription === 'string' ? this.#listeners.get(subscription) : undefined;
    if (listener === undefined) return;
    const event = toEvent(method, params);
    if (event !== null) listener(event);
  }

  /** Runs an effect of a kind this application provides. */
  async #answer(method: string, params: Json): Promise<Json> {
    if (method !== 'effect/run' || !isObject(params))
      throw new RpcError(-32601, `unknown method ${method}`);
    const { session, key, kind, args, attempt } = params;
    if (typeof session !== 'string' || typeof key !== 'string' || typeof kind !== 'string') {
      throw new RpcError(-32602, 'effect/run needs session, key and kind');
    }
    const handler = this.#provides[kind];
    if (handler === undefined) return { error: `this client does not provide ${kind}` };
    const controller = new AbortController();
    const id = runKey(session, key);
    this.#running.set(id, controller);
    try {
      const result = await handler({
        session,
        key,
        kind,
        args: args ?? null,
        attempt: typeof attempt === 'number' ? attempt : 1,
        signal: controller.signal,
        emit: (delta) => this.#peer.notify('effect/emit', { session, key, delta }),
        log: {
          list: async (query = {}) => {
            const page = await this.log(session, query);
            return page.cursor === undefined ? { entries: page.entries } : page;
          },
        },
      });
      return { ok: result };
    } catch (error) {
      return {
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
      };
    } finally {
      this.#running.delete(id);
    }
  }
}

function toEvent(method: string, params: JsonObject): SessionEvent | null {
  switch (method) {
    case 'log':
      return Array.isArray(params['entries'])
        ? { type: 'log', entries: params['entries'].filter(isEntry) }
        : null;
    case 'view':
      return { type: 'view', view: params['view'] ?? null };
    case 'status': {
      const status = params['status'];
      const fault = params['fault'];
      if (status !== 'idle' && status !== 'busy' && status !== 'faulted') return null;
      return { type: 'status', status, fault: typeof fault === 'string' ? fault : null };
    }
    case 'emit':
      return typeof params['key'] === 'string'
        ? { type: 'emit', key: params['key'], delta: params['delta'] ?? null }
        : null;
    default:
      return null;
  }
}

function isEntry(value: Json): value is LogEntry {
  return (
    isObject(value) &&
    typeof value['seq'] === 'number' &&
    typeof value['at'] === 'number' &&
    typeof value['kind'] === 'string' &&
    'body' in value
  );
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  'closed',
  'no_agent',
  'no_session',
  'session_exists',
  'bundle_conflict',
  'invalid_bundle',
  'missing_kinds',
  'request_conflict',
  'kind_taken',
  'agent_in_use',
  'not_initialized',
  'protocol_version',
  'invalid_params',
  'internal',
]);

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function toRef(agent: AgentRef | string): AgentRef {
  if (typeof agent !== 'string') return agent;
  const at = agent.lastIndexOf('@');
  if (at <= 0) throw new RunnerRequestError('invalid_params', `${agent} is not name@version`);
  return { name: agent.slice(0, at), version: agent.slice(at + 1) };
}

function runKey(session: unknown, key: unknown): string {
  return JSON.stringify([session ?? null, key ?? null]);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
