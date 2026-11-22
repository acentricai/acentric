// What each route does, once a request has been read and let through. A handler is given what
// its route takes, checked, and answers with what its route answers.

import { AgentNotFound, reaches, reportOf } from '@acentric/core';
import type {
  Accounts,
  Audit,
  Engine,
  Keys,
  Machines,
  People,
  Secrets,
  SignedIn,
  UsageFilter,
} from '@acentric/core';
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

import { personOf, sessionCookie } from './auth.ts';
import type { Granted } from './auth.ts';
import { ApiFailure } from './errors.ts';
import type { Streams } from './events.ts';

export type Parts = {
  readonly engine: Engine;
  readonly keys: Keys;
  readonly people: People;
  readonly audit: Audit;
  readonly secrets: Secrets;
  readonly accounts: Accounts;
  readonly streams: Streams;
};

/** An answer with headers of its own: what sets, or clears, the dashboard's cookie. */
export class Reply<T> {
  readonly body: T;
  readonly headers: { readonly [name: string]: string };
  constructor(body: T, headers: { readonly [name: string]: string }) {
    this.body = body;
    this.headers = headers;
  }
}

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

type Answered<I extends RouteId> = (typeof routes)[I] extends
  { readonly stream: true } | { readonly bytes: true }
  ? Response
  : (typeof routes)[I] extends { readonly response: z.ZodType }
    ? ResponseOf<I>
    : undefined;

type Gives<T> = T | Reply<T> | Promise<T | Reply<T>>;

export type Handlers = {
  readonly [I in RouteId]?: (asked: Asked<I>, parts: Parts) => Gives<Answered<I>>;
};

/**
 * A person signed in, as they are answered. The dashboard is given its session in a cookie
 * its scripts cannot read, and no token. The command is given the token.
 */
function signed(
  request: Request,
  signedIn: SignedIn,
): Reply<ResponseOf<'auth.signIn'>> | ResponseOf<'auth.signIn'> {
  const { user, session, token } = signedIn;
  if (session.client === 'cli') return { user, session, token };
  return new Reply(
    { user, session },
    { 'set-cookie': sessionCookie(request, token, session.expiresAt) },
  );
}

/** A page of a list that is all in memory, in order: those after the cursor, `limit` at most. */
function pageOf<T extends { readonly id: string }>(
  all: readonly T[],
  query: { readonly limit: number; readonly cursor?: string | undefined },
): Page<T> {
  const { cursor, limit } = query;
  const rest = cursor === undefined ? all : all.filter((item) => item.id > cursor);
  const items = rest.slice(0, limit);
  return { items, nextCursor: rest.length > limit ? (items.at(-1)?.id ?? null) : null };
}

const refOf = (granted: Granted): PrincipalRef =>
  granted.principal.type === 'key'
    ? { type: 'key', id: granted.principal.key }
    : { type: 'user', id: granted.principal.user };

const summaryOf = ({ definition: _definition, ...summary }: Deployment): DeploymentSummary =>
  summary;

/** The agent or the actor a request was let through to. It is always there for such a route. */
const agentOf = (asked: Granted): Agent => asked.agent as Agent;
const actorOf = (asked: Granted): Actor => asked.actor as Actor;

/** The engine's machines. An engine that keeps none has no such routes to answer. */
function machinesOf(engine: Engine): Machines {
  if (engine.machines === undefined) {
    throw new ApiFailure('not_found', 'This engine keeps no machines');
  }
  return engine.machines;
}

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
  'agents.update': async (asked, { engine, accounts, audit }) => {
    const { activeVersion, account } = asked.body;
    let agent = agentOf(asked);
    if (activeVersion === undefined && account === undefined) {
      throw new ApiFailure('invalid_request', 'Nothing to change was given');
    }
    // Both are done, or neither: a version there is not is refused before anything is changed.
    if (activeVersion !== undefined && activeVersion > agent.latestDeployment.version) {
      throw new AgentNotFound(agent.id, activeVersion);
    }
    if (account !== undefined) {
      agent = await accounts.give(refOf(asked), agent, account);
      engine.forgetAgent(agent.id);
    }
    if (activeVersion !== undefined) {
      agent = await engine.activate(agent.id, activeVersion);
      await audit.record({
        by: refOf(asked),
        action: 'agent.activate',
        target: { type: 'agent', id: agent.id },
        detail: { name: agent.name, version: activeVersion },
      });
    }
    return agent;
  },
  'agents.delete': async (asked, { engine, audit }) => {
    const agent = agentOf(asked);
    await engine.deleteAgent(agent.id);
    await audit.record({
      by: refOf(asked),
      action: 'agent.delete',
      target: { type: 'agent', id: agent.id },
      detail: { name: agent.name },
    });
    return undefined;
  },

  'deployments.create': async (asked, { engine, audit }) => {
    const { body, scope } = asked;
    // A key that does not reach the whole engine deploys to what it reaches, and makes no agent.
    if (scope.type !== 'engine') {
      const there = await engine.findAgent(body.agent);
      if (there === undefined || !reaches(scope, { agent: there.id })) {
        throw new ApiFailure('forbidden', `The key does not reach an agent named ${body.agent}`);
      }
    }
    const deployed = await engine.deploy({ ...body, by: refOf(asked) });
    if (deployed.created) {
      await audit.record({
        by: refOf(asked),
        action: 'agent.deploy',
        target: { type: 'agent', id: deployed.agent.id },
        detail: { name: deployed.agent.name, version: deployed.deployment.version },
      });
    }
    return deployed;
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
  'secrets.set': async (asked, { secrets, audit }) => {
    await secrets.set(agentOf(asked).id, asked.params.name, asked.body.value);
    // The name, and never the value.
    await audit.record({
      by: refOf(asked),
      action: 'secret.set',
      target: { type: 'agent', id: agentOf(asked).id },
      detail: { name: asked.params.name },
    });
    return undefined;
  },
  'secrets.delete': async (asked, { secrets, audit }) => {
    if (!(await secrets.delete(agentOf(asked).id, asked.params.name))) {
      throw new ApiFailure('not_found', `The agent has no secret ${asked.params.name}`);
    }
    await audit.record({
      by: refOf(asked),
      action: 'secret.delete',
      target: { type: 'agent', id: agentOf(asked).id },
      detail: { name: asked.params.name },
    });
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
  'actors.update': async (asked, { engine }) => {
    const { env, ...rest } = asked.body;
    const { id } = actorOf(asked);
    // Its variables alone are changed at any time. Anything else is changed between turns.
    if (env === undefined || Object.keys(defined(rest)).length > 0) {
      const updated = await engine.updateActor(id, defined(rest));
      if (env === undefined) return updated;
    }
    return engine.setEnv(id, env);
  },
  'actors.archive': (asked, { engine }) => engine.archive(actorOf(asked).id),
  'actors.unarchive': (asked, { engine }) => engine.unarchive(actorOf(asked).id),
  'actors.interrupt': (asked, { engine }) => engine.interrupt(actorOf(asked).id),
  'actors.abort': (asked, { engine }) => engine.abort(actorOf(asked).id),
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

  // Tasks

  'tasks.list': async (asked, { engine }) => ({
    items: await engine.tasks.list(actorOf(asked).id, defined(asked.query)),
  }),
  'tasks.get': (asked, { engine }) => engine.tasks.get(actorOf(asked).id, asked.params.task),
  'tasks.stop': (asked, { engine }) => engine.tasks.stop(actorOf(asked).id, asked.params.task),

  // Machines

  'machines.create': async (asked, { engine, audit }) => {
    const added = await machinesOf(engine).add(defined(asked.body));
    await audit.record({
      by: refOf(asked),
      action: 'machine.create',
      target: { type: 'machine', id: added.machine.id },
      detail: { name: added.machine.name },
    });
    return added;
  },
  'machines.list': async ({ query }, { engine }) => {
    const machines = machinesOf(engine);
    if (query.name === undefined) return { items: await machines.list() };
    const one = await machines.find(query.name);
    return { items: one === undefined ? [] : [one] };
  },
  'machines.get': ({ params }, { engine }) => machinesOf(engine).get(params.machine),
  'machines.update': async (asked, { engine, audit }) => {
    const machine = await machinesOf(engine).update(asked.params.machine, defined(asked.body));
    await audit.record({
      by: refOf(asked),
      action: 'machine.update',
      target: { type: 'machine', id: machine.id },
      detail: { name: machine.name, agents: machine.agents },
    });
    return machine;
  },
  'machines.delete': async (asked, { engine, audit }) => {
    const machines = machinesOf(engine);
    const machine = await machines.get(asked.params.machine);
    await machines.remove(machine.id);
    await audit.record({
      by: refOf(asked),
      action: 'machine.delete',
      target: { type: 'machine', id: machine.id },
      detail: { name: machine.name },
    });
    return undefined;
  },
  'machines.token': async (asked, { engine, audit }) => {
    const given = await machinesOf(engine).token(asked.params.machine);
    await audit.record({
      by: refOf(asked),
      action: 'machine.token',
      target: { type: 'machine', id: given.machine.id },
      detail: { name: given.machine.name },
    });
    return given;
  },
  'machines.upgrade': async (asked, { engine, audit }) => {
    const upgraded = await machinesOf(engine).upgrade(asked.params.machine);
    if (upgraded.updated) {
      await audit.record({
        by: refOf(asked),
        action: 'machine.upgrade',
        target: { type: 'machine', id: upgraded.machine.id },
        detail: { name: upgraded.machine.name, version: upgraded.machine.version },
      });
    }
    return upgraded;
  },
  // A daemon's own: its machine's token is what lets it.
  'machines.enrol': async ({ params, body }, { engine, audit }) => {
    const machine = await machinesOf(engine).enrol(params.machine, body);
    await audit.record({
      by: { type: 'system' },
      action: 'machine.enrol',
      target: { type: 'machine', id: machine.id },
      detail: { name: machine.name },
    });
    return { id: machine.id };
  },

  'blobs.get': async (asked, { engine }) => {
    const { digest } = asked.params;
    const found = await engine.blobs.read(actorOf(asked).id, digest);
    if (found === undefined) {
      throw new ApiFailure('not_found', `The actor has no blob ${digest}`);
    }
    const { blob, bytes } = found;
    // What an agent's code said the bytes are is not to be trusted with the dashboard's
    // origin: nothing in them runs, a browser does not guess at what they are, and only an
    // image is shown in place.
    const shown = /^image\/(png|jpeg|gif|webp|avif)$/.test(blob.mediaType);
    return new Response(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      status: 200,
      headers: {
        'content-type': blob.mediaType,
        'content-length': String(bytes.byteLength),
        'content-disposition': shown ? 'inline' : 'attachment',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // The name is the digest of the bytes: what it names never changes.
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${digest}"`,
      },
    });
  },

  // API keys

  'keys.create': async (asked, { keys, audit }) => {
    const made = await keys.create(asked.principal, defined(asked.body));
    await audit.record({
      by: refOf(asked),
      action: 'key.create',
      target: { type: 'key', id: made.key.id },
      detail: { label: made.key.label, scope: made.key.scope },
    });
    return made;
  },
  'keys.list': async (asked, { keys }) => {
    // Oldest first, a page at a time: the cursor is the ID of the last key of the page before.
    const { limit, cursor } = asked.query;
    const all = await keys.list(asked.principal);
    const rest = cursor === undefined ? all : all.filter((key) => key.id > cursor);
    const items = rest.slice(0, limit);
    return { items, nextCursor: rest.length > limit ? (items.at(-1)?.id ?? null) : null };
  },
  'keys.get': (asked, { keys }) => keys.get(asked.principal, asked.params.key),
  'keys.revoke': async (asked, { keys, audit }) => {
    await keys.revoke(asked.principal, asked.params.key);
    await audit.record({
      by: refOf(asked),
      action: 'key.revoke',
      target: { type: 'key', id: asked.params.key },
    });
    return undefined;
  },

  // Model accounts, and what was used

  'accounts.create': (asked, { accounts }) => accounts.add(refOf(asked), defined(asked.body)),
  'accounts.list': async ({ query }, { accounts }) => pageOf(await accounts.list(), query),
  'accounts.get': ({ params }, { accounts }) => accounts.get(params.account),
  'accounts.update': (asked, { accounts }) =>
    accounts.update(refOf(asked), asked.params.account, defined(asked.body)),
  'accounts.delete': async (asked, { accounts }) => {
    await accounts.remove(refOf(asked), asked.params.account);
    return undefined;
  },
  'usage.get': ({ query, scope }, { engine }) => {
    const { by, ...asked } = query;
    const filter: UsageFilter = defined(asked);
    // A key is told of what it reaches, whatever it asks for: of the rest there is nothing.
    const reached =
      scope.type === 'engine'
        ? filter
        : scope.type === 'agent'
          ? { ...filter, agent: scope.agent }
          : { ...filter, actor: scope.actor };
    if (
      (filter.agent !== undefined && filter.agent !== reached.agent) ||
      (filter.actor !== undefined && filter.actor !== reached.actor)
    ) {
      return reportOf([], {}, by);
    }
    return engine.usage(reached, by);
  },
  'usage.actor': (asked, { engine }) => engine.usage({ actor: actorOf(asked).id }),

  // Signing in

  'setup.complete': async ({ body, request }, { people }) =>
    signed(request, await people.setup(defined(body))),
  'auth.signIn': async ({ body, request }, { people }) =>
    signed(request, await people.signIn(defined(body))),
  'auth.signOut': async ({ principal, request }, { people }) => {
    await people.signOut(personOf(principal));
    return new Reply(undefined, { 'set-cookie': sessionCookie(request) });
  },
  'me.update': ({ principal, body }, { people }) => people.updateMe(personOf(principal), body),
  'me.password': async ({ principal, body }, { people }) => {
    await people.changePassword(personOf(principal), body);
    return undefined;
  },
  'password.reset': async ({ body }, { people }) => {
    await people.reset(body);
    return undefined;
  },
  'invites.create': ({ principal, body }, { people }) => people.invite(principal, defined(body)),
  'invites.list': async ({ query }, { people }) => pageOf(await people.invites(), query),
  'invites.revoke': async ({ principal, params }, { people }) => {
    await people.revokeInvite(principal, params.invite);
    return undefined;
  },
  'invites.accept': async ({ body, request }, { people }) =>
    signed(request, await people.accept(defined(body))),

  // People and their sessions

  'users.list': async ({ query }, { people }) => pageOf(await people.list(), query),
  'users.get': ({ params }, { people }) => people.get(params.user),
  'users.update': ({ principal, params, body }, { people }) =>
    people.update(principal, params.user, defined(body)),
  'users.resetPassword': ({ principal, params }, { people }) =>
    people.resetLink(principal, params.user),
  'users.delete': async ({ principal, params }, { people }) => {
    await people.remove(principal, params.user);
    return undefined;
  },
  'sessions.list': async ({ principal, query }, { people }) =>
    pageOf(await people.sessions(personOf(principal).user), query),
  'sessions.revoke': async ({ principal, params }, { people }) => {
    await people.endSession(personOf(principal), params.session);
    return undefined;
  },
  'audit.list': ({ query }, { audit }) => {
    const { limit, cursor, action } = query;
    return audit.list({ limit, ...defined({ cursor, action }) });
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
