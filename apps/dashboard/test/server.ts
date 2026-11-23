// A stand-in for the server, as the dashboard's tests have it: the routes of signing in, answered
// as the server answers them, and every call written down. Installed as the page's `fetch`.

type Person = { readonly id: string; readonly email: string; password: string };

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

  const principal = (email: string) => ({
    type: 'user',
    user: `usr_${email.split('@')[0] ?? 'x'}`,
    email,
    role: 'owner',
    permissions: [],
    session: 'ses_1',
  });
  const add = (email: string, password: string): Person => {
    const person = { id: `usr_${String(people.size + 1)}`, email, password };
    people.set(email, person);
    return person;
  };
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

  const answer = (method: string, path: string, body: Record<string, unknown>): Response => {
    if (method === 'GET' && path === '/v1/me') {
      return signedIn === undefined
        ? refused(401, 'unauthenticated', 'The request has no key')
        : json(200, principal(signedIn));
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
    return refusal === undefined ? answer(method, url.pathname, body) : refusal();
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    /** A person who has an account, signed in or not. */
    person(email: string, password: string, signIn = false) {
      add(email, password);
      if (signIn) signedIn = email;
    },
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
