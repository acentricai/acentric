// A typed client of the engine's API and of an actor's event stream: what the command, the
// dashboard and a developer's own program call the engine with.
//
// It calls by the table of routes the server answers by, so a call is typed by its route: what
// it takes in its path, its query and its body, and what it answers with.
//
//     const client = createClient({ baseUrl: 'https://engine.example.com', token });
//     const { actor } = await client.call('actors.create', { params: { agent }, body: {} });
//     await client.call('inputs.send', {
//       params: { actor: actor.id },
//       body: { type: 'message', payload: { text: 'Hello' } },
//     });
//     for await (const event of client.events(actor.id)) console.log(event);

import { fillPath, fromSse, routes } from '@acentric/protocol';
import type {
  ActorEvent,
  ActorId,
  BodyOf,
  ErrorCode,
  ErrorResponse,
  Issue,
  ParamsOf,
  QueryOf,
  QueryValuesOf,
  ResponseOf,
  Route,
  RouteId,
} from '@acentric/protocol';

/** A request the engine refused, or failed. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** What a program decides by. The message is for a person, and may change. */
  readonly code: ErrorCode | 'unknown';
  /** The HTTP status it was answered with. */
  readonly status: number;
  /** For a request that failed a schema: each thing wrong with it. */
  readonly issues: readonly Issue[] | undefined;
  /** The server's ID for the request, to find it in the server's logs by. */
  readonly requestId: string | undefined;

  constructor(status: number, error: Partial<ErrorResponse['error']>) {
    super(error.message ?? `The engine answered ${String(status)}`);
    this.code = error.code ?? 'unknown';
    this.status = status;
    this.issues = error.issues;
    this.requestId = error.requestId;
  }
}

export type ClientOptions = {
  /** Where the engine is, such as `https://engine.example.com`. */
  readonly baseUrl: string;
  /** The API key requests are made with. */
  readonly token?: string;
  /** In place of the world's `fetch`. */
  readonly fetch?: typeof fetch;
};

/**
 * A route's query, each part as it is written in a URL or as the value it stands for: `true`
 * as well as `'true'`.
 */
export type QueryGiven<I extends RouteId> = {
  readonly [K in keyof QueryOf<I>]?:
    QueryOf<I>[K] | (K extends keyof QueryValuesOf<I> ? QueryValuesOf<I>[K] : never);
};

type Has<I extends RouteId, K extends string> = (typeof routes)[I] extends {
  readonly [P in K]: unknown;
}
  ? true
  : false;

/** What a call of route `I` is given: its path's parameters, its query and its body, as it has them. */
export type CallInput<I extends RouteId> = (Has<I, 'params'> extends true
  ? { readonly params: ParamsOf<I> }
  : unknown) &
  (Has<I, 'query'> extends true ? { readonly query?: QueryGiven<I> } : unknown) &
  (Has<I, 'body'> extends true ? { readonly body: BodyOf<I> } : unknown) & {
    /** Gives the call up. */
    readonly signal?: AbortSignal;
  };

/** A call of a route that needs nothing may be given nothing. */
type Given<I extends RouteId> =
  Has<I, 'params'> extends true
    ? [input: CallInput<I>]
    : Has<I, 'body'> extends true
      ? [input: CallInput<I>]
      : [input?: CallInput<I>];

/** What route `I` answers with: nothing, for a route that answers with none. */
export type Answer<I extends RouteId> = Has<I, 'response'> extends true ? ResponseOf<I> : undefined;

export type Client = {
  /** Calls a route. Rejects with an `ApiError` when the engine refuses or fails. */
  call<I extends RouteId>(id: I, ...given: Given<I>): Promise<Answer<I>>;
  /**
   * Follows an actor: each message of its conversation as it is stored, and where it stands
   * when that changes. With `after`, every message after that place comes first. It goes on
   * until `signal` is aborted, or the engine ends the stream.
   */
  events(
    actor: ActorId,
    options?: { readonly after?: number; readonly signal?: AbortSignal },
  ): AsyncIterable<ActorEvent>;
};

type Loose = {
  readonly params?: { readonly [name: string]: string };
  readonly query?: { readonly [name: string]: unknown };
  readonly body?: unknown;
  readonly signal?: AbortSignal;
};

export function createClient(options: ClientOptions): Client {
  const send = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  const request = async (route: Route, input: Loose, accept: string): Promise<Response> => {
    const url = new URL(base + fillPath(route.path, input.params));
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const response = await send(url, {
      method: route.method,
      headers: {
        accept,
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (response.ok) return response;
    // A failure is the engine's envelope. Anything else is from something in between.
    const text = await response.text();
    let error: Partial<ErrorResponse['error']> = {};
    try {
      error = (JSON.parse(text) as Partial<ErrorResponse>).error ?? {};
    } catch {
      error = { message: text.slice(0, 500) || response.statusText };
    }
    throw new ApiError(response.status, error);
  };

  return {
    async call(id, ...given) {
      const route: Route = routes[id];
      const response = await request(route, (given[0] ?? {}) as Loose, 'application/json');
      if (response.status === 204) return undefined as never;
      return (await response.json()) as never;
    },

    async *events(actor, more = {}) {
      const route: Route = routes['events.stream'];
      const response = await request(
        route,
        {
          params: { actor },
          ...(more.after === undefined ? {} : { query: { after: more.after } }),
          ...(more.signal === undefined ? {} : { signal: more.signal }),
        },
        'text/event-stream',
      );
      if (response.body === null) return;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += value;
          // An event ends with an empty line.
          for (;;) {
            const end = buffer.search(/\r?\n\r?\n/);
            if (end === -1) break;
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice('data:'.length).replace(/^ /, ''))
              .join('\n');
            // A block with no data is a comment: a sign the stream is alive.
            if (data !== '') yield fromSse({ data });
          }
        }
      } catch (error) {
        // Given up by whoever followed: the stream ends, and that is no failure.
        if (more.signal?.aborted !== true) throw error;
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
