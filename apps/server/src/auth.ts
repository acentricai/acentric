// Who a request is from, and whether a route lets them through.
//
// A request names what it is about in its path. One that is on an agent or an actor is let
// through when its key reaches that agent or actor and holds the route's permission. What a
// key does not reach is, to it, not there: it is answered as what does not exist is.

import { Forbidden, reaches } from '@acentric/core';
import type { Engine, Keys } from '@acentric/core';
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

export async function authenticate(keys: Keys, request: Request): Promise<Principal> {
  const header = request.headers.get('authorization') ?? undefined;
  const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  return keys.authenticate(token);
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
