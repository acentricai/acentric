// Who a request is from, and whether a route lets them through.
//
// A request comes with an API key, or with the session of a person signed in. The command
// sends a session's token as it sends a key. The dashboard has its session in a cookie its
// scripts cannot read, and a request that changes something with that cookie has to come from
// the server's own pages: a page of another site cannot have a person's browser act for it.
//
// A request names what it is about in its path. One that is on an agent or an actor is let
// through when its key reaches that agent or actor and holds the route's permission. What a
// key does not reach is, to it, not there: it is answered as what does not exist is.

import { Forbidden, Unauthenticated, reaches } from '@acentric/core';
import type { Engine, Keys, People } from '@acentric/core';
import type {
  Actor,
  ActorId,
  Agent,
  AgentId,
  Principal,
  RouteAuth,
  Scope,
} from '@acentric/protocol';

import { ApiFailure } from './errors.ts';

/** What a request was let through to: the agent or the actor it is on, when it is on one. */
export type Granted = {
  readonly principal: Principal;
  readonly scope: Scope;
  readonly agent?: Agent;
  readonly actor?: Actor;
};

/** What a principal reaches. A person reaches the whole engine. */
export const scopeOf = (principal: Principal): Scope =>
  principal.type === 'key' ? principal.scope : { type: 'engine' };

/** The cookie the dashboard's session is in. */
export const SESSION_COOKIE = 'acentric_session';

/** The session token in a request's cookies, if it has one. */
function cookieOf(request: Request): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length > 0) return value.join('=');
  }
  return undefined;
}

/** What sets, or with no token clears, the dashboard's session cookie. */
export function sessionCookie(request: Request, token?: string, expiresAt?: number): string {
  // Sent only over HTTPS where the server is reached by it, directly or through what is in front.
  const https =
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https';
  const seconds =
    token === undefined || expiresAt === undefined
      ? 0
      : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${token ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(seconds)}`,
    ...(https ? ['Secure'] : []),
  ].join('; ');
}

export async function authenticate(
  keys: Keys,
  people: People,
  request: Request,
): Promise<Principal> {
  const header = request.headers.get('authorization') ?? undefined;
  const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  if (token !== undefined) {
    return token.startsWith('as_') ? people.authenticate(token) : keys.authenticate(token);
  }
  const cookie = cookieOf(request);
  if (cookie === undefined) return keys.authenticate(undefined);
  // A request that changes something with a cookie comes from the server's own pages.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host') ?? new URL(request.url).host;
    if (origin === null || !URL.canParse(origin) || new URL(origin).host !== host) {
      throw new Unauthenticated(
        'A request that changes something with a session cookie comes from the server’s own pages',
      );
    }
  }
  return people.authenticate(cookie);
}

/** The person a request is from, for what only a person signed in does. */
export function personOf(principal: Principal): Extract<Principal, { type: 'user' }> {
  if (principal.type !== 'user') throw new Forbidden('This is for a person signed in, not a key');
  return principal;
}

/** Lets a principal through a route, or throws with why not. */
export async function authorize(
  engine: Engine,
  principal: Principal,
  auth: RouteAuth,
  params: { readonly [name: string]: string },
): Promise<Granted> {
  const scope = scopeOf(principal);
  if (auth.on === 'any' || auth.on === 'none') return { principal, scope };
  if (!principal.permissions.includes(auth.permission)) {
    throw new Forbidden(`This takes ${auth.permission}, which the key does not hold`);
  }
  switch (auth.on) {
    case 'reach':
      return { principal, scope };
    case 'engine':
      if (scope.type !== 'engine') throw new Forbidden('This takes a key of the whole engine');
      return { principal, scope };
    case 'agent': {
      const id = params[auth.param] as AgentId;
      const agent = await engine.getAgent(id);
      if (!reaches(scope, { agent: agent.id })) {
        throw new ApiFailure('not_found', `There is no agent ${id}`);
      }
      return { principal, scope, agent };
    }
    case 'actor': {
      const id = params[auth.param] as ActorId;
      const actor = await engine.getActor(id);
      if (!reaches(scope, { agent: actor.agent, actor: actor.id })) {
        throw new ApiFailure('not_found', `There is no actor ${id}`);
      }
      return { principal, scope, actor };
    }
  }
}
