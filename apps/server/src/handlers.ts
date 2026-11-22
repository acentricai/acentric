// What each route does, once a request has been read and let through. A handler is given what
// its route takes, checked, and answers with what its route answers.

import { reaches } from '@acentric/core';
import type { Engine, Keys, Secrets } from '@acentric/core';
import type {
  Actor,
  Agent,
  Deployment,
  DeploymentSummary,
  Page,
  PrincipalRef,
  ResponseOf,
  RouteId,
  routes,
} from '@acentric/protocol';
import type { z } from 'zod';

import type { Granted } from './auth.ts';
import { ApiFailure } from './errors.ts';
import type { Streams } from './events.ts';

export type Parts = {
  readonly engine: Engine;
  readonly keys: Keys;
  readonly secrets: Secrets;
  readonly streams: Streams;
};

type Shape<I extends RouteId, K extends string> = (typeof routes)[I] extends {
  readonly [P in K]: infer S extends z.ZodType;
}
  ? z.output<S>
  : undefined;

/** What a handler of route `I` is given. */
export type Asked<I extends RouteId> = Granted & {
  readonly params: Shape<I, 'params'>;
  readonly query: Shape<I, 'query'>;
  readonly body: Shape<I, 'body'>;
  readonly request: Request;
};

type Answered<I extends RouteId> = (typeof routes)[I] extends { readonly stream: true }
  ? Response
  : (typeof routes)[I] extends { readonly response: z.ZodType }
    ? ResponseOf<I>
    : undefined;

export type Handlers = {
  readonly [I in RouteId]?: (asked: Asked<I>, parts: Parts) => Promise<Answered<I>> | Answered<I>;
};

const refOf = (granted: Granted): PrincipalRef =>
  granted.principal.type === 'key'
    ? { type: 'key', id: granted.principal.key }
    : { type: 'user', id: granted.principal.user };

const summaryOf = ({ definition: _definition, ...summary }: Deployment): DeploymentSummary =>
  summary;

/** The agent or the actor a request was let through to. It is always there for such a route. */
const agentOf = (asked: Granted): Agent => asked.agent as Agent;
const actorOf = (asked: Granted): Actor => asked.actor as Actor;

/** A list that is all on one page. */
const onePage = <T>(items: T[]): Page<T> => ({ items, nextCursor: null });

export const handlers: Handlers = {
  'me.get': ({ principal }) => principal,

  // Agents and deployments

  'agents.list': async ({ query, scope }, { engine }) => {
    // A key of one agent sees that agent. A name names one agent at most.
    if (scope.type === 'agent' || query.name !== undefined) {
      const one =
        query.name === undefined
          ? await engine.getAgent((scope as { agent: Agent['id'] }).agent)
          : await engine.findAgent(query.name);
      return onePage(one !== undefined && reaches(scope, { agent: one.id }) ? [one] : []);
    }
    if (scope.type === 'actor') return onePage([]);
    const { limit, cursor } = query;
    return engine.listAgents({ limit, ...(cursor === undefined ? {} : { cursor }) });
  },
  'agents.get': (asked) => agentOf(asked),
  'agents.update': (asked, { engine }) =>
    engine.activate(agentOf(asked).id, asked.body.activeVersion),
  'agents.delete': async (asked, { engine }) => {
    await engine.deleteAgent(agentOf(asked).id);
    return undefined;
  },

  'deployments.create': async (asked, { engine }) => {
    const { body, scope } = asked;
    // A key that does not reach the whole engine deploys to what it reaches, and makes no agent.
    if (scope.type !== 'engine') {
      const there = await engine.findAgent(body.agent);
      if (there === undefined || !reaches(scope, { agent: there.id })) {
        throw new ApiFailure('forbidden', `The key does not reach an agent named ${body.agent}`);
      }
    }
    return engine.deploy({ ...body, by: refOf(asked) });
  },
  'deployments.list': async (asked, { engine }) => {
    const { limit, cursor } = asked.query;
    const page = await engine.listDeployments(agentOf(asked).id, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
  },
  'deployments.get': async (asked, { engine }) => {
    const deployment = await engine.getDeployment(asked.params.deployment).catch(() => undefined);
    if (deployment === undefined || deployment.agent !== agentOf(asked).id) {
      throw new ApiFailure('not_found', `The agent has no deployment ${asked.params.deployment}`);
    }
    return deployment;
  },

  // An agent's secrets

  'secrets.list': async (asked, { secrets }) => ({
    items: await secrets.list(agentOf(asked).id),
  }),
  'secrets.set': async (asked, { secrets }) => {
    await secrets.set(agentOf(asked).id, asked.params.name, asked.body.value);
    return undefined;
  },
  'secrets.delete': async (asked, { secrets }) => {
    if (!(await secrets.delete(agentOf(asked).id, asked.params.name))) {
      throw new ApiFailure('not_found', `The agent has no secret ${asked.params.name}`);
    }
    return undefined;
  },

  // Actors

  'actors.create': (asked, { engine }) =>
    engine.createActor({ agent: agentOf(asked).id, ...defined(asked.body) }),
  'actors.list': async ({ query, scope }, { engine }) => {
    // What a key does not reach is not in its list, whatever it asks for.
    if (scope.type === 'agent' && query.agent !== undefined && query.agent !== scope.agent) {
      return onePage([]);
    }
    const { limit, cursor, ...filters } = query;
    return engine.listActors({
      limit,
      ...defined({ cursor, ...filters }),
      ...(scope.type === 'agent' ? { agent: scope.agent } : {}),
      ...(scope.type === 'actor' ? { actor: scope.actor } : {}),
    });
  },
  'actors.get': (asked) => actorOf(asked),
  'actors.update': (asked, { engine }) =>
    engine.updateActor(actorOf(asked).id, defined(asked.body)),
  'actors.archive': (asked, { engine }) => engine.archive(actorOf(asked).id),
  'actors.unarchive': (asked, { engine }) => engine.unarchive(actorOf(asked).id),
  'actors.interrupt': (asked, { engine }) => engine.interrupt(actorOf(asked).id),
  'actors.retry': (asked, { engine }) => engine.retry(actorOf(asked).id),

  // Inputs, the conversation and its events

  'inputs.send': (asked, { engine }) =>
    engine.send(actorOf(asked).id, defined(asked.body) as Parameters<Engine['send']>[1]),
  'inputs.list': (asked, { engine }) => {
    const { limit, cursor, pending } = asked.query;
    return engine.listInputs(actorOf(asked).id, { limit, ...defined({ cursor, pending }) });
  },
  'messages.list': async (asked, { engine }) => {
    const { limit, cursor, order } = asked.query;
    // A cursor is the place of the last message of the page before.
    const from = cursor === undefined ? undefined : Number(cursor);
    if (from !== undefined && !Number.isInteger(from)) {
      throw new ApiFailure('invalid_request', 'The cursor is not one this list gave');
    }
    const after = order === 'asc' ? (from ?? asked.query.after) : asked.query.after;
    const before = order === 'desc' ? (from ?? asked.query.before) : asked.query.before;
    // One more than was asked for says whether there is a next page.
    const entries = await engine.conversation(actorOf(asked).id, {
      order,
      limit: limit + 1,
      ...defined({ after, before }),
    });
    const items = entries.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: entries.length > limit && last !== undefined ? String(last.seq) : null,
    };
  },
  'events.stream': (asked, { engine, streams }) => {
    // One who comes back says where they left off, as a browser does by itself, or in the query.
    const header = asked.request.headers.get('last-event-id');
    const seen = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
    return streams.follow(engine, actorOf(asked), seen ?? asked.query.after, asked.request);
  },

  // API keys

  'keys.create': (asked, { keys }) => keys.create(asked.principal, defined(asked.body)),
  'keys.list': async (asked, { keys }) => {
    // Oldest first, a page at a time: the cursor is the ID of the last key of the page before.
    const { limit, cursor } = asked.query;
    const all = await keys.list(asked.principal);
    const rest = cursor === undefined ? all : all.filter((key) => key.id > cursor);
    const items = rest.slice(0, limit);
    return { items, nextCursor: rest.length > limit ? (items.at(-1)?.id ?? null) : null };
  },
  'keys.get': (asked, { keys }) => keys.get(asked.principal, asked.params.key),
  'keys.revoke': async (asked, { keys }) => {
    await keys.revoke(asked.principal, asked.params.key);
    return undefined;
  },
};

/** An object without the fields that were not given. */
function defined<T extends { readonly [key: string]: unknown }>(
  given: T,
): { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(
    Object.entries(given).filter(([, value]) => value !== undefined),
  ) as never;
}
