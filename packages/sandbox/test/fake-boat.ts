// A Boat for tests: it answers the calls made of Boat's API as Boat does, keeps the sandboxes
// it was asked for, and tells the test when one is to start or to stop, so that the test can
// run the daemon that a real sandbox would.

type Json = { readonly [key: string]: unknown };

/** A sandbox, as this Boat has it. */
export type FakeSandbox = {
  readonly id: string;
  state: string;
  readonly type: string;
  readonly name: string;
  readonly labels: { readonly [name: string]: string };
  /** What it was last told to stop itself after, in seconds. */
  ttlSeconds: number;
  /** The files it was made with. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
  /** What it was made from. */
  readonly from: string;
};

/** One call of the API, as this Boat received it. */
export type BoatCall = {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Json | undefined;
};

export type FakeBoat = {
  readonly fetch: typeof fetch;
  /** Every call received, in order. */
  readonly calls: BoatCall[];
  /** The calls of a method whose path matches. */
  callsOf(method: string, path: RegExp): BoatCall[];
  readonly sandboxes: Map<string, FakeSandbox>;
  /** The API keys it takes. */
  readonly keys: Set<string>;
  /** Called when a sandbox was made, and when one was started again: the test starts its daemon. */
  onStart: (sandbox: FakeSandbox, how: 'created' | 'resumed') => void;
  /** Answers the next call of a method whose path matches with this, in place of what it would. */
  failNext(method: string, path: RegExp, status: number, body?: Json): void;
  /** Stops a sandbox as Boat does when its timer runs out: its disk is kept. */
  archive(id: string): void;
  /** How many sandboxes a page of a list has. */
  pageSize: number;
};

export function fakeBoat(): FakeBoat {
  const calls: BoatCall[] = [];
  const sandboxes = new Map<string, FakeSandbox>();
  const keys = new Set(['boat-key-1']);
  const failures: { method: string; path: RegExp; status: number; body: Json }[] = [];
  let next = 1;

  const answer = (status: number, body: Json): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failed = (status: number, code: string, message: string): Response =>
    answer(status, { error: { code, message } });

  const boat: FakeBoat = {
    calls,
    sandboxes,
    keys,
    onStart: () => undefined,
    pageSize: 200,
    callsOf: (method, path) =>
      calls.filter((call) => call.method === method && path.test(call.path)),
    failNext: (
      method,
      path,
      status,
      body = { error: { code: 'internal', message: 'Boat failed' } },
    ) => {
      failures.push({ method, path, status, body });
    },
    archive: (id) => {
      const sandbox = sandboxes.get(id);
      if (sandbox !== undefined) sandbox.state = 'archived';
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '') + url.search;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
      calls.push({ method, path, headers, body });

      const failure = failures.findIndex((one) => one.method === method && one.path.test(path));
      if (failure !== -1) {
        const [one] = failures.splice(failure, 1);
        return answer(one?.status ?? 500, one?.body ?? {});
      }
      const key = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
      if (key === undefined || !keys.has(key))
        return failed(401, 'unauthorized', 'The API key is not valid');

      if (method === 'GET' && path === '/me')
        return answer(200, { user: { email: 'dev@example.com' } });

      if (method === 'POST' && path === '/sandboxes') {
        const sandbox: FakeSandbox = {
          id: `sbx_${String(next++)}`,
          state: 'provisioning',
          type: String(body?.['type']),
          name: String(body?.['name']),
          labels: (body?.['labels'] ?? {}) as { [name: string]: string },
          ttlSeconds: Number(body?.['ttlSeconds']),
          files: (body?.['files'] ?? []) as { path: string; content: string }[],
          from: String(body?.['from']),
        };
        sandboxes.set(sandbox.id, sandbox);
        // It starts after the call is answered, as a real one does.
        setTimeout(() => {
          if (sandboxes.get(sandbox.id) !== sandbox) return;
          sandbox.state = 'running';
          boat.onStart(sandbox, 'created');
        }, 10);
        return answer(201, {
          sandbox: {
            id: sandbox.id,
            state: sandbox.state,
            type: sandbox.type,
            labels: sandbox.labels,
          },
        });
      }

      if (method === 'GET' && path.startsWith('/sandboxes?')) {
        const [label, value] = (url.searchParams.get('label') ?? '=').split('=');
        const found = [...sandboxes.values()].filter((one) => one.labels[label ?? ''] === value);
        // A page at a time, when a test says how long a page is.
        const from = Number(url.searchParams.get('cursor') ?? 0);
        const page = found.slice(from, from + boat.pageSize);
        const more = from + boat.pageSize < found.length;
        return answer(200, {
          sandboxes: page.map((one) => ({
            id: one.id,
            state: one.state,
            type: one.type,
            labels: one.labels,
          })),
          pageInfo: { hasMore: more, nextCursor: more ? String(from + boat.pageSize) : null },
        });
      }

      const match = /^\/sandboxes\/([^/?]+)(\/resume)?$/.exec(path);
      const sandbox =
        match === null ? undefined : sandboxes.get(decodeURIComponent(match[1] ?? ''));
      if (match === null) return failed(404, 'not_found', 'There is no such route');
      if (sandbox === undefined)
        return failed(404, 'sandbox_not_found', 'There is no such sandbox');

      if (method === 'GET' && match[2] === undefined) {
        return answer(200, {
          sandbox: {
            id: sandbox.id,
            state: sandbox.state,
            type: sandbox.type,
            labels: sandbox.labels,
          },
        });
      }
      if (method === 'PATCH' && match[2] === undefined) {
        sandbox.ttlSeconds = Number(body?.['ttlSeconds']);
        return answer(200, { sandbox: { id: sandbox.id, state: sandbox.state } });
      }
      if (method === 'POST' && match[2] !== undefined) {
        if (sandbox.state === 'archiving')
          return failed(409, 'sandbox_stopping', 'It is still stopping');
        if (sandbox.state === 'provisioning')
          return failed(409, 'sandbox_resuming', 'It is starting already');
        sandbox.ttlSeconds = Number(body?.['ttlSeconds']);
        sandbox.state = 'provisioning';
        setTimeout(() => {
          if (sandboxes.get(sandbox.id) !== sandbox) return;
          sandbox.state = 'running';
          boat.onStart(sandbox, 'resumed');
        }, 10);
        return answer(200, { sandbox: { id: sandbox.id, state: sandbox.state } });
      }
      if (method === 'DELETE' && match[2] === undefined) {
        if (headers.get('x-ascii-confirm-delete') !== sandbox.id) {
          return failed(
            400,
            'confirmation_required',
            'A delete is confirmed with the ID of the sandbox',
          );
        }
        sandboxes.delete(sandbox.id);
        return answer(200, { deleted: true });
      }
      return failed(404, 'not_found', 'There is no such route');
    }) as typeof fetch,
  };
  return boat;
}
