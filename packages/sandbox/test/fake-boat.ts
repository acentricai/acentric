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
  /** The files put in it since, by their path: text, or the bytes put at an upload's address. */
  readonly written: Map<string, string | Uint8Array>;
  /** The commands run in it, in order. */
  readonly commands: string[];
};

/** What a command ends with, as a test says. */
export type FakeRun = {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

/** A snapshot saved in this Boat. */
export type FakeSaved = { readonly name: string; readonly sandboxId: string; status: string };

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
  /** The saved snapshots, by name. */
  readonly saved: Map<string, FakeSaved>;
  /** What the processor of a new sandbox is, as `uname -m` says. */
  arch: string;
  /**
   * How a command that is not detached ends. Without one of the test's, the build's own are
   * answered as a sandbox would: its processor, the end of a file, and an install that works.
   */
  onCommand: (sandbox: FakeSandbox, command: string) => FakeRun | undefined;
  /** How a detached command ends, and how many looks at it see it running first. */
  onDetached: (sandbox: FakeSandbox, command: string) => FakeRun & { readonly looks?: number };
  /** How many looks at a snapshot being saved see it saving, and how it ends. */
  saving: { looks: number; ends: 'ready' | 'failed' };
};

/** A command of a build, as a sandbox of Boat's answers it. */
function ownRun(box: FakeSandbox, command: string): FakeRun {
  if (command === 'uname -m') return { exitCode: 0, stdout: `${fakeArch(box)}\n` };
  const tail = /^tail -c \d+ (\S+)$/.exec(command);
  if (tail !== null) {
    const text = box.written.get(tail[1] ?? '');
    return { exitCode: 0, stdout: typeof text === 'string' ? text : '' };
  }
  if (command.includes('acentric-machine --version')) {
    return { exitCode: 0, stdout: 'acentric-machine 0.0.0\n' };
  }
  return { exitCode: 0 };
}

const archOf = new WeakMap<FakeSandbox, string>();
const fakeArch = (box: FakeSandbox): string => archOf.get(box) ?? 'x86_64';

export function fakeBoat(): FakeBoat {
  const calls: BoatCall[] = [];
  const sandboxes = new Map<string, FakeSandbox>();
  const keys = new Set(['boat-key-1']);
  const saved = new Map<string, FakeSaved>();
  /** How many more looks each snapshot being saved is seen saving, and how it ends. */
  const saving = new Map<string, { looks: number; ends: 'ready' | 'failed' }>();
  /** The detached commands, by their process ID. */
  const processes = new Map<
    number,
    { sandbox: FakeSandbox; run: FakeRun; looks: number; log?: string; killed: boolean }
  >();
  let pid = 100;
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
    saved,
    arch: 'x86_64',
    onCommand: () => undefined,
    onDetached: () => ({ exitCode: 0, stdout: 'the script ran\n' }),
    saving: { looks: 1, ends: 'ready' },
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
      // An upload's address is signed: it is put to with no key.
      if (url.host === 'uploads.boat.test') {
        calls.push({ method, path, headers, body: undefined });
        const [, id, ...rest] = url.pathname.split('/');
        const into = sandboxes.get(id ?? '');
        if (method !== 'PUT' || into === undefined) return failed(404, 'not_found', 'No upload');
        into.written.set(`/${rest.join('/')}`, new Uint8Array(init?.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
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
          written: new Map(),
          commands: [],
        };
        sandboxes.set(sandbox.id, sandbox);
        archOf.set(sandbox, boat.arch);
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

      if (path === '/saved-snapshots' && method === 'POST') {
        const name = String(body?.['name']);
        const from = sandboxes.get(String(body?.['sandboxId']));
        if (from === undefined) return failed(404, 'sandbox_not_found', 'There is no such sandbox');
        saved.set(name, { name, sandboxId: from.id, status: 'saving' });
        saving.set(name, { ...boat.saving });
        return answer(202, { status: 'saving', snapshot: { name, status: 'saving' } });
      }
      const snapshot = /^\/saved-snapshots\/([^/?]+)$/.exec(path);
      if (snapshot !== null) {
        const name = decodeURIComponent(snapshot[1] ?? '');
        const one = saved.get(name);
        if (one === undefined) return failed(404, 'not_found', 'not_found');
        if (method === 'GET') {
          const until = saving.get(name);
          if (until !== undefined && until.looks-- <= 0) {
            one.status = until.ends;
            saving.delete(name);
          }
          return answer(200, {
            snapshot: {
              name,
              status: one.status,
              error: one.status === 'failed' ? 'the disk could not be read' : null,
            },
          });
        }
        if (method === 'DELETE') {
          saved.delete(name);
          return answer(200, { name, status: 'deleted' });
        }
      }

      const inside = /^\/sandboxes\/([^/?]+)\/(commands|files)(?:\/([^/?]+))?$/.exec(path);
      if (inside !== null) {
        const box = sandboxes.get(decodeURIComponent(inside[1] ?? ''));
        if (box === undefined) return failed(404, 'sandbox_not_found', 'There is no such sandbox');
        if (inside[2] === 'files' && method === 'PUT' && inside[3] === undefined) {
          box.written.set(String(body?.['path']), String(body?.['content']));
          return answer(200, { success: true, path: body?.['path'] });
        }
        if (inside[2] === 'files' && method === 'POST' && inside[3] === 'upload-url') {
          return answer(200, {
            method: 'PUT',
            url: `https://uploads.boat.test/${box.id}${String(body?.['path'])}`,
          });
        }
        if (inside[2] === 'commands' && method === 'POST' && inside[3] === undefined) {
          const command = String(body?.['command']);
          box.commands.push(command);
          if (body?.['detached'] === true) {
            const run = boat.onDetached(box, command);
            const id = pid++;
            const log = /> (\S+) 2>&1/.exec(command)?.[1];
            processes.set(id, {
              sandbox: box,
              run,
              looks: run.looks ?? 0,
              killed: false,
              ...(log === undefined ? {} : { log }),
            });
            return answer(200, { type: 'command.started', processId: id, pid: id });
          }
          const run = boat.onCommand(box, command) ?? ownRun(box, command);
          return answer(200, {
            type: 'command.finished',
            exitCode: run.exitCode,
            stdout: run.stdout ?? '',
            stderr: run.stderr ?? '',
            timedOut: false,
          });
        }
        const process = processes.get(Number(inside[3]));
        if (inside[2] === 'commands' && process !== undefined && process.sandbox === box) {
          if (method === 'DELETE') {
            process.killed = true;
            return answer(200, { stopped: true });
          }
          if (method === 'GET') {
            const running = !process.killed && process.looks-- > 0;
            // What it printed is in its log once it has ended.
            if (!running && process.log !== undefined) {
              box.written.set(process.log, process.run.stdout ?? '');
            }
            return answer(200, {
              type: 'command.status',
              running,
              exitCode: running ? null : process.killed ? null : process.run.exitCode,
            });
          }
        }
        return failed(404, 'not_found', 'There is no such route');
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
