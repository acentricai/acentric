// A stand-in for the server, as the dashboard's tests have it: the routes of signing in, of
// machines and of sandboxes, answered as the server answers them, and every call written down.
// Installed as the page's `fetch`.

import { ROLE_PERMISSIONS } from '@acentric/protocol';
import type { Actor, Machine, Role, Sandbox, SandboxProviderAccount } from '@acentric/protocol';

type Person = { readonly id: string; readonly email: string; password: string; role: Role };

const NOW = 1_795_305_600_000;

/** A machine as the server has one just added: not enrolled, for the agents given. */
export function machineOf(name: string, more: Partial<Machine> = {}): Machine {
  return {
    id: `mch_${name.replaceAll('-', '').padEnd(26, '0').slice(0, 26)}` as Machine['id'],
    name,
    agents: [],
    enrolled: false,
    online: false,
    os: null,
    arch: null,
    home: null,
    hostname: null,
    version: null,
    current: null,
    provider: null,
    createdAt: NOW,
    enrolledAt: null,
    lastSeenAt: null,
    ...more,
  };
}

/** An actor of an agent, idle and on no machine unless said. */
export function actorOf(id: string, agent: string, more: Partial<Actor> = {}): Actor {
  return {
    id: id as Actor['id'],
    name: null,
    externalId: null,
    agent: agent as Actor['agent'],
    deployment: { id: `dep_${'0'.repeat(26)}` as never, version: 1 },
    pinned: false,
    behind: null,
    modelId: 'fake-1',
    reasoning: 'medium',
    configuration: null,
    machine: null,
    parent: null,
    status: 'idle',
    lastTurn: null,
    pendingInputs: 0,
    createdAt: NOW,
    archivedAt: null,
    ...more,
  } as Actor;
}

export type FakeServer = ReturnType<typeof fakeServer>;

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const refused = (status: number, code: string, message: string, more: object = {}) =>
  json(status, { error: { code, message, ...more } });

export function fakeServer() {
  const people = new Map<string, Person>();
  const links = new Map<string, { kind: 'setup' | 'invite' | 'reset'; email?: string }>();
  /** Who the browser's cookie is for: no one, without it. */
  let signedIn: string | undefined;
  /** What the next call is refused with, when a test says so. */
  let next: (() => Response) | undefined;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const machines: Machine[] = [];
  const agents: { id: string; name: string }[] = [];
  const providers: SandboxProviderAccount[] = [];
  const sandboxes: Sandbox[] = [];
  const actors: Actor[] = [];
  let made = 0;

  const principal = (person: Person) => ({
    type: 'user',
    user: person.id,
    email: person.email,
    role: person.role,
    permissions: ROLE_PERMISSIONS[person.role],
    session: 'ses_1',
  });
  const add = (email: string, password: string, role: Role = 'owner'): Person => {
    const person = { id: `usr_${String(people.size + 1)}`, email, password, role };
    people.set(email, person);
    return person;
  };
  const machine = (id: string) => machines.find((one) => one.id === id);
  const signedInAnswer = (person: Person) => {
    signedIn = person.email;
    return json(201, {
      user: {
        id: person.id,
        email: person.email,
        displayName: null,
        role: 'owner',
        createdAt: 0,
        disabledAt: null,
      },
      session: {
        id: 'ses_1',
        user: person.id,
        client: 'dashboard',
        label: null,
        createdAt: 0,
        lastUsedAt: null,
        expiresAt: 1,
      },
    });
  };

  const answer = (
    method: string,
    path: string,
    body: Record<string, unknown>,
    query: URLSearchParams,
  ): Response => {
    if (method === 'GET' && path === '/v1/me') {
      const person = signedIn === undefined ? undefined : people.get(signedIn);
      return person === undefined
        ? refused(401, 'unauthenticated', 'The request has no key')
        : json(200, principal(person));
    }
    if (method === 'POST' && path === '/v1/sign-in') {
      const person = people.get(String(body['email']));
      if (person === undefined || person.password !== body['password']) {
        return refused(401, 'invalid_credentials', 'The email or the password is wrong');
      }
      return signedInAnswer(person);
    }
    if (method === 'POST' && path === '/v1/sign-out') {
      signedIn = undefined;
      return json(204, null);
    }
    const link = links.get(String(body['token']));
    if (method === 'POST' && (path === '/v1/setup' || path === '/v1/invites/accept')) {
      const kind = path === '/v1/setup' ? 'setup' : 'invite';
      if (link?.kind !== kind) {
        return refused(
          400,
          'invalid_link',
          'The link is not known, was used already, or has expired',
        );
      }
      const email = String(body['email']);
      if (people.has(email)) return refused(409, 'conflict', 'The email is taken');
      if (String(body['password']).length < 10) {
        return refused(400, 'invalid_request', 'The body is not what this takes', {
          issues: [{ message: 'A password is 10 characters or more', path: ['password'] }],
        });
      }
      links.delete(String(body['token']));
      return signedInAnswer(add(email, String(body['password'])));
    }
    if (method === 'POST' && path === '/v1/password-reset') {
      const person = link?.kind === 'reset' ? people.get(link.email ?? '') : undefined;
      if (person === undefined) {
        return refused(
          400,
          'invalid_link',
          'The link is not known, was used already, or has expired',
        );
      }
      links.delete(String(body['token']));
      person.password = String(body['password']);
      if (signedIn === person.email) signedIn = undefined;
      return json(204, null);
    }
    return machineRoutes(method, path, body, query);
  };

  /** The routes of machines and sandboxes, for one signed in. */
  const machineRoutes = (
    method: string,
    path: string,
    body: Record<string, unknown>,
    query: URLSearchParams,
  ): Response => {
    if (signedIn === undefined) return refused(401, 'unauthenticated', 'The request has no key');
    if (method === 'GET' && path === '/v1/actors') {
      const items = actors.filter(
        (actor) =>
          actor.agent === query.get('agent') &&
          (query.get('status') === null || actor.status === query.get('status')),
      );
      return json(200, { items, nextCursor: null });
    }
    const anActor = /^\/v1\/actors\/([^/]+)$/.exec(path);
    if (method === 'GET' && anActor !== null) {
      const found = actors.find((actor) => actor.id === anActor[1]);
      return found === undefined
        ? refused(404, 'not_found', 'There is no such actor')
        : json(200, found);
    }
    if (method === 'GET' && path === '/v1/agents') {
      return json(200, { items: agents, nextCursor: null });
    }
    if (method === 'GET' && path === '/v1/machines') {
      const agentsAsked = query.get('agent')?.split(',');
      const actorsAsked = query.get('actor')?.split(',');
      if (agentsAsked === undefined && actorsAsked === undefined) {
        return json(200, { items: machines });
      }
      // As the server has it: the machines of the agents' actors not archived, and of the actors.
      const used = new Set(
        actors
          .filter(
            (actor) =>
              (agentsAsked?.includes(actor.agent) === true && actor.status !== 'archived') ||
              actorsAsked?.includes(actor.id) === true,
          )
          .map((actor) => actor.machine?.id),
      );
      return json(200, { items: machines.filter((one) => used.has(one.id)) });
    }
    if (method === 'POST' && path === '/v1/machines') {
      const name = String(body['name']);
      if (machines.some((one) => one.name === name)) {
        return refused(409, 'name_taken', `There is a machine ${name} already`);
      }
      const added = machineOf(name, { agents: (body['agents'] ?? []) as Machine['agents'] });
      machines.push(added);
      return json(201, { machine: added, token: `token-${name}`, expiresAt: NOW + 3_600_000 });
    }
    const one = /^\/v1\/machines\/([^/]+)(\/token)?$/.exec(path);
    if (one !== null) {
      const found = machine(one[1] ?? '');
      if (found === undefined) return refused(404, 'not_found', 'There is no such machine');
      if (method === 'POST' && one[2] === '/token') {
        made += 1;
        return json(201, { machine: found, token: `token-again-${String(made)}`, expiresAt: NOW });
      }
      if (method === 'PATCH') {
        Object.assign(found, { agents: body['agents'] });
        return json(200, found);
      }
      if (method === 'DELETE') {
        machines.splice(machines.indexOf(found), 1);
        return json(204, null);
      }
    }
    if (method === 'GET' && path === '/v1/providers') return json(200, { items: providers });
    if (method === 'POST' && path === '/v1/providers') {
      if (body['kind'] !== 'boat' || typeof body['apiKey'] !== 'string') {
        return refused(400, 'invalid_request', 'The body is not what this takes');
      }
      if (body['apiKey'] === 'boat_refused') {
        return refused(502, 'sandbox_provider_failed', 'Boat refused the API key');
      }
      made += 1;
      const added: SandboxProviderAccount = {
        id: `prv_${String(made).padStart(26, '0')}` as SandboxProviderAccount['id'],
        kind: 'boat',
        name: String(body['name']),
        account: 'ada@example.test',
        sandboxes: 0,
        createdAt: NOW,
      };
      providers.push(added);
      return json(201, added);
    }
    const provider = /^\/v1\/providers\/([^/]+)(\/sandboxes)?$/.exec(path);
    if (provider !== null) {
      const found = providers.find((each) => each.id === provider[1]);
      if (found === undefined) return refused(404, 'not_found', 'There is no such account');
      if (method === 'GET' && provider[2] === '/sandboxes') {
        return json(200, { items: sandboxes.filter((each) => each.provider === found.id) });
      }
      if (method === 'DELETE') {
        if (sandboxes.some((each) => each.provider === found.id)) {
          return refused(409, 'conflict', "Remove this account's sandboxes first");
        }
        providers.splice(providers.indexOf(found), 1);
        return json(204, null);
      }
    }
    if (method === 'POST' && path === '/v1/sandboxes') {
      const account = providers.find((each) => each.id === body['provider']);
      if (account === undefined) return refused(404, 'not_found', 'There is no such account');
      made += 1;
      const added = machineOf(String(body['name'] ?? `sandbox-${String(made)}`), {
        agents: (body['agents'] ?? []) as Machine['agents'],
        provider: account.id,
        enrolled: true,
        online: true,
        os: 'linux',
        arch: 'x64',
      });
      machines.push(added);
      const sandbox: Sandbox = {
        machine: added,
        provider: account.id,
        kind: account.kind,
        providerSandboxId: `sbx_${String(made)}`,
        vcpu: Number(body['vcpu']),
        memoryGB: Number(body['memoryGB']),
        idleTimeoutSeconds: Number(body['idleTimeoutSeconds'] ?? 3600),
        state: 'running',
      };
      sandboxes.push(sandbox);
      account.sandboxes += 1;
      return json(201, sandbox);
    }
    const sandbox = /^\/v1\/sandboxes\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && sandbox !== null) {
      const found = sandboxes.find((each) => each.machine.id === sandbox[1]);
      if (found === undefined) return refused(404, 'not_found', 'There is no such sandbox');
      sandboxes.splice(sandboxes.indexOf(found), 1);
      machines.splice(
        machines.findIndex((each) => each.id === found.machine.id),
        1,
      );
      return json(204, null);
    }
    return refused(404, 'not_found', 'There is no such route');
  };

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, path: url.pathname, body });
    const refusal = next;
    next = undefined;
    return refusal === undefined ? answer(method, url.pathname, body, url.searchParams) : refusal();
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    /** A person who has an account, signed in or not, an owner unless said. */
    person(email: string, password: string, signIn = false, role: Role = 'owner') {
      add(email, password, role);
      if (signIn) signedIn = email;
    },
    machines,
    agents,
    actors,
    providers,
    sandboxes,
    link(token: string, kind: 'setup' | 'invite' | 'reset', email?: string) {
      links.set(token, { kind, ...(email === undefined ? {} : { email }) });
    },
    /** The next call is answered with this, whatever it is. */
    refuseNext(make: () => Response) {
      next = make;
    },
    refused,
    get signedIn() {
      return signedIn;
    },
  };
}
