// What each route does, once a request has been read and let through. A handler is given what
// its route takes, checked, and answers with what its route answers.

import { AgentNotFound, MachineRefused, reaches, reportOf } from '@acentric/core';
import type {
  Accounts,
  Audit,
  Engine,
  Keys,
  Machines,
  People,
  Sandboxes,
  Secrets,
  SignedIn,
  StoredCommand,
  UsageFilter,
} from '@acentric/core';
import { FILE_BYTES, PHOTO_BYTES, idsOf } from '@acentric/protocol';
import type {
  Actor,
  Agent,
  Deployment,
  DeploymentSummary,
  MachineCommand,
  MachineId,
  Page,
  PrincipalRef,
  ResponseOf,
  RouteId,
  routes,
  Scope,
  Updates,
} from '@acentric/protocol';
import type { z } from 'zod';

import { personOf, sessionCookie } from './auth.ts';
import { deviceOf } from './device.ts';
import type { Granted } from './auth.ts';
import { ApiFailure } from './errors.ts';
import type { BackupControl } from './backups/control.ts';
import type { UpdateCheck } from './updates.ts';
import type { UpdaterFolder } from './updater.ts';
import type { Streams } from './events.ts';

export type Parts = {
  readonly engine: Engine;
  readonly keys: Keys;
  readonly people: People;
  readonly audit: Audit;
  readonly secrets: Secrets;
  readonly accounts: Accounts;
  readonly streams: Streams;
  /** The server's own backups, and how they are set. */
  readonly backups?: BackupControl;
  /** Whether there are versions after this one. */
  readonly updates?: UpdateCheck;
  /** The folder of the updater beside the server. Undefined for none. */
  readonly updater?: UpdaterFolder;
  /** What the server says it is. */
  readonly version?: string;
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

/**
 * The usage a key is told of: what it reaches, whatever it asks for. Undefined when it asks for
 * an agent or an actor it does not reach: of those there is nothing.
 */
function reachedBy(scope: Scope, filter: UsageFilter): UsageFilter | undefined {
  const reached =
    scope.type === 'engine'
      ? filter
      : scope.type === 'agent'
        ? { ...filter, agent: scope.agent }
        : { ...filter, actor: scope.actor };
  return (filter.agent !== undefined && filter.agent !== reached.agent) ||
    (filter.actor !== undefined && filter.actor !== reached.actor)
    ? undefined
    : reached;
}

const refOf = (granted: Granted): PrincipalRef =>
  granted.principal.type === 'key'
    ? { type: 'key', id: granted.principal.key }
    : { type: 'user', id: granted.principal.user };

/** A server whose backups are off. */
const noBackups = () =>
  new ApiFailure(
    'unavailable',
    'This server takes no backups of its own: they are off, in its settings or as set through the API',
  );

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

/** The engine's sandboxes. An engine that keeps no machines makes none. */
function sandboxesOf(engine: Engine): Sandboxes {
  if (engine.sandboxes === undefined) {
    throw new ApiFailure('not_found', 'This engine keeps no machines');
  }
  return engine.sandboxes;
}

/**
 * Has a machine there to be reached, as before an actor's command: a sandbox that sleeps is
 * woken, and one on its way back to an engine that just started is given the time.
 */
async function ready(engine: Engine, machine: MachineId, signal: AbortSignal): Promise<void> {
  await engine.sandboxes?.wake(machine);
  await machinesOf(engine).settled(machine, signal);
}

/** How long a call waits for a command it started, without being told: in seconds. */
const COMMAND_WAIT_S = 30;
/** How long a call that stops a command waits for it to have ended. */
const STOP_WAIT_S = 20;
/** The most of a running command's output a call is given: the end of it. */
const RUNNING_TAIL_BYTES = 64 << 10;

/** A command of a machine's own, as a caller is given it. */
function commandView(command: StoredCommand): MachineCommand {
  const { actor: _actor, task, stopWanted: _wanted, ...rest } = command;
  return { id: task, ...rest };
}

/**
 * A command of a machine's own once it has ended, or as it stands after `seconds`, or when the
 * caller goes. One that has not ended is given with the end of what it has written so far.
 */
async function waited(
  machines: Machines,
  request: Request,
  command: StoredCommand,
  seconds: number,
): Promise<MachineCommand> {
  const ref = { actor: command.actor, task: command.task };
  const open = (one: StoredCommand) => one.status === 'starting' || one.status === 'running';
  let now = command;
  if (seconds > 0 && open(now)) {
    const signal = AbortSignal.any([AbortSignal.timeout(seconds * 1000), request.signal]);
    now = (await machines.ended(ref, signal)) ?? (await machines.command(ref)) ?? now;
  } else {
    now = (await machines.command(ref)) ?? now;
  }
  if (!open(now)) return commandView(now);
  // The end of its output is kept once it ends: until then, it is read from its log.
  let output: string | null = null;
  if (now.log !== null) {
    try {
      const { size } = await machines.read(now.machine, { path: now.log, max: 1 });
      const from = Math.max(0, size - RUNNING_TAIL_BYTES);
      const read = await machines.read(now.machine, {
        path: now.log,
        from,
        max: RUNNING_TAIL_BYTES,
      });
      output = Buffer.from(read.data, 'base64').toString('utf8');
    } catch {
      // Not there yet, or the machine went: it has no output to give now.
    }
  }
  return { ...commandView(now), output };
}

/** What a file of a machine could not be read or written for, as the API says it. */
function fileFailure(error: unknown): unknown {
  if (error instanceof MachineRefused && error.reason === 'not_found') {
    return new ApiFailure('not_found', error.message);
  }
  return error;
}

/** A list that is all on one page. */
const onePage = <T>(items: T[]): Page<T> => ({ items, nextCursor: null });

/** A sign-in that names its session, or one named by the browser it came from. */
function named<T extends { readonly label?: string }>(body: T, request: Request): T {
  if (body.label !== undefined) return body;
  const device = deviceOf(request.headers.get('user-agent'));
  return device === undefined ? body : { ...body, label: device };
}

export const handlers: Handlers = {
  'me.get': ({ principal }) => principal,

  // Agents and deployments

  'agents.list': async ({ query, scope }, { engine }) => {
    // A key of one agent sees that agent. A name names one agent at most.
    if (scope.type === 'agent' || query.name !== undefined) {
      const one =
        query.name === undefined
          ? // A key of an agent that was deleted sees none: the list of one is empty.
            await engine
              .getAgent((scope as { agent: Agent['id'] }).agent)
              .catch((error: unknown) => {
                if (error instanceof AgentNotFound) return undefined;
                throw error;
              })
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
  'actors.delete': async (asked, { engine, audit }) => {
    const actor = actorOf(asked);
    const gone = await engine.deleteActor(actor.id);
    await audit.record({
      by: refOf(asked),
      action: 'actor.delete',
      target: { type: 'actor', id: actor.id },
      detail: { agent: actor.agent, actors: gone.length },
    });
    return undefined;
  },
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

  'actors.compact': ({ params }, { engine }) => engine.compact(params.actor),
  'actors.compactions': async ({ params }, { engine }) => ({
    items: await engine.compactions(params.actor),
  }),
  'actors.subagents': async ({ params }, { engine }) => ({
    items: await engine.children(params.actor),
  }),

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
    const agents = idsOf(query.agent, 'agent');
    const actors = idsOf(query.actor, 'actor');
    const usedBy =
      query.agent === undefined && query.actor === undefined ? undefined : { agents, actors };
    if (query.name === undefined) return { items: await machines.list(usedBy) };
    const one = await machines.find(query.name);
    const used = one === undefined || usedBy === undefined ? [] : await machines.list(usedBy);
    const kept = usedBy === undefined || used.some((machine) => machine.id === one?.id);
    return { items: one === undefined || !kept ? [] : [one] };
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
    // A sandbox is deleted at its provider with it.
    if (machine.provider === null) await machines.remove(machine.id);
    else await sandboxesOf(engine).remove(machine.id);
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
  // A machine's own commands and files, for setting it up from outside

  'machineCommands.run': async ({ params, body, request }, { engine }) => {
    const machines = machinesOf(engine);
    await ready(engine, params.machine, request.signal);
    const started = await machines.startOwn(params.machine, {
      command: body.command,
      cwd: body.cwd ?? '~',
      ...(body.timeout === undefined ? {} : { timeout: body.timeout }),
    });
    return waited(machines, request, started, body.wait ?? COMMAND_WAIT_S);
  },
  'machineCommands.list': async ({ params, query }, { engine }) => ({
    items: (await machinesOf(engine).owns(params.machine, query.limit)).map(commandView),
  }),
  'machineCommands.get': async ({ params, query, request }, { engine }) => {
    const machines = machinesOf(engine);
    const command = await machines.own(params.machine, params.command);
    return waited(machines, request, command, query.wait ?? 0);
  },
  'machineCommands.stop': async ({ params, request }, { engine }) => {
    const machines = machinesOf(engine);
    const command = await machines.own(params.machine, params.command);
    await machines.stop({ actor: command.actor, task: command.task });
    return waited(machines, request, command, STOP_WAIT_S);
  },
  'machineFiles.read': async ({ params, query, request }, { engine }) => {
    const machines = machinesOf(engine);
    try {
      await ready(engine, params.machine, request.signal);
      const read = await machines.read(params.machine, {
        path: query.path,
        from: query.from ?? 0,
        max: query.max ?? FILE_BYTES,
      });
      const bytes = Buffer.from(read.data, 'base64');
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'x-file-size': String(read.size),
          'x-file-from': String(read.from),
        },
      });
    } catch (error) {
      throw fileFailure(error);
    }
  },
  'machineFiles.write': async ({ params, query, request }, { engine }) => {
    const machines = machinesOf(engine);
    const tooLarge = () =>
      new ApiFailure(
        'too_large',
        'A file is written 8 MiB at a time at most: write the rest with `from`',
      );
    if (Number(request.headers.get('content-length') ?? 0) > FILE_BYTES) throw tooLarge();
    // Counted as it comes: a body sent in chunks says no length, and is not read past the most.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength;
      if (size > FILE_BYTES) throw tooLarge();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    try {
      await ready(engine, params.machine, request.signal);
      return await machines.write(params.machine, {
        path: query.path,
        from: query.from ?? 0,
        data: bytes.toString('base64'),
      });
    } catch (error) {
      throw fileFailure(error);
    }
  },

  // A daemon's own: its machine's token is what lets it.
  // Sandboxes: machines the engine makes at a provider

  'sandboxProviders.list': async (_asked, { engine }) => ({
    items: await sandboxesOf(engine).providers(),
  }),
  'sandboxProviders.create': async (asked, { engine, audit }) => {
    const added = await sandboxesOf(engine).addProvider(defined(asked.body));
    await audit.record({
      by: refOf(asked),
      action: 'sandbox_provider.create',
      target: { type: 'sandbox_provider', id: added.id },
      detail: { name: added.name, kind: added.kind },
    });
    return added;
  },
  'sandboxProviders.delete': async (asked, { engine, audit }) => {
    const sandboxes = sandboxesOf(engine);
    const provider = (await sandboxes.providers()).find((one) => one.id === asked.params.provider);
    await sandboxes.removeProvider(asked.params.provider);
    await audit.record({
      by: refOf(asked),
      action: 'sandbox_provider.delete',
      target: { type: 'sandbox_provider', id: asked.params.provider },
      detail: { name: provider?.name ?? null },
    });
    return undefined;
  },
  'sandboxProviders.sandboxes': async ({ params }, { engine }) => ({
    items: await sandboxesOf(engine).list(params.provider),
  }),
  'sandboxes.create': async (asked, { engine, audit }) => {
    // Where the request came to: where its daemon dials, for a server not told where it is reached.
    const origin = new URL(asked.request.url).origin;
    const made = await sandboxesOf(engine).create(defined(asked.body), origin);
    await audit.record({
      by: refOf(asked),
      action: 'sandbox.create',
      target: { type: 'machine', id: made.machine.id },
      detail: { name: made.machine.name, provider: made.provider, kind: made.kind },
    });
    return made;
  },
  'sandboxes.delete': async (asked, { engine, audit }) => {
    const machine = await machinesOf(engine).get(asked.params.machine);
    await sandboxesOf(engine).remove(machine.id);
    await audit.record({
      by: refOf(asked),
      action: 'sandbox.delete',
      target: { type: 'machine', id: machine.id },
      detail: { name: machine.name },
    });
    return undefined;
  },

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
    const { by, split, tz, ...asked } = query;
    const grouping = defined({ by, split, tz });
    const reached = reachedBy(scope, defined(asked));
    return reached === undefined ? reportOf([], {}, grouping) : engine.usage(reached, grouping);
  },
  'usage.calls': ({ query, scope }, { engine }) => {
    const { limit, cursor, ...asked } = query;
    const reached = reachedBy(scope, defined(asked));
    return reached === undefined
      ? { items: [], nextCursor: null }
      : engine.usageCalls({ ...reached, limit, ...defined({ cursor }) });
  },
  'usage.actor': (asked, { engine }) => engine.usage({ actor: actorOf(asked).id }),

  // Signing in

  'setup.complete': async ({ body, request }, { people }) =>
    signed(request, await people.setup(named(defined(body), request))),
  'auth.signIn': async ({ body, request }, { people }) =>
    signed(request, await people.signIn(named(defined(body), request))),
  'auth.signOut': async ({ principal, request }, { people }) => {
    await people.signOut(personOf(principal));
    return new Reply(undefined, { 'set-cookie': sessionCookie(request) });
  },
  'me.update': ({ principal, body }, { people }) => people.updateMe(personOf(principal), body),
  'me.setPhoto': async ({ principal, request }, { people }) => {
    const tooLarge = () =>
      new ApiFailure('too_large', `A picture is ${String(PHOTO_BYTES / 1024 / 1024)} MiB at most`);
    if (Number(request.headers.get('content-length') ?? 0) > PHOTO_BYTES) throw tooLarge();
    // Counted as it comes, as a file sent to a machine is.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength;
      if (size > PHOTO_BYTES) throw tooLarge();
      chunks.push(chunk);
    }
    return people.setPhoto(personOf(principal), new Uint8Array(Buffer.concat(chunks)));
  },
  'me.removePhoto': ({ principal }, { people }) => people.setPhoto(personOf(principal), null),
  'users.photo': async ({ params }, { people }) => {
    const photo = await people.photo(params.user);
    if (photo === undefined) throw new ApiFailure('not_found', `${params.user} has no picture`);
    const { bytes } = photo;
    return new Response(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      status: 200,
      headers: {
        // What it is was found from its bytes when it was given.
        'content-type': photo.mediaType,
        'content-length': String(bytes.byteLength),
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // Asked for by the picture it is (`?v=`): another picture is another address.
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${photo.digest}"`,
      },
    });
  },
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
    signed(request, await people.accept(named(defined(body), request))),

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
  'backups.list': async (_asked, parts) => {
    const backups = parts.backups?.current;
    if (backups === undefined) throw noBackups();
    const { items, bucketError } = await backups.list();
    return {
      dir: backups.dir,
      sameDisk: await backups.sameDisk(),
      everyMs: backups.everyMs,
      keep: backups.keep,
      next: backups.next,
      last: backups.last,
      bucket:
        backups.bucketUrl === undefined ? null : { url: backups.bucketUrl, error: bucketError },
      items,
    };
  },
  'backups.create': async (asked, parts) => {
    const backups = parts.backups?.current;
    if (backups === undefined) throw noBackups();
    const file = await backups.take('manual', refOf(asked));
    // Taken, it is in the folder, and in the bucket when there is one.
    return { ...file, onServer: true, inBucket: backups.bucketUrl !== undefined };
  },
  'backups.settings': (_asked, { backups }) => {
    if (backups === undefined) throw noBackups();
    return backups.settings();
  },
  'backups.configure': async (asked, { backups }) => {
    if (backups === undefined) throw noBackups();
    return backups.configure(asked.body, refOf(asked));
  },
  'updates.get': async (asked, parts) => updatesOf(parts, asked.query.refresh === true),
  'updates.request': async (asked, parts) => {
    const { updater, audit } = parts;
    if (updater === undefined || !(await updater.alive())) throw noUpdater();
    const now = await updatesOf(parts);
    if (now.next !== asked.body.version) {
      throw new ApiFailure(
        'conflict',
        now.next === null
          ? `There is no version to take after ${now.current}`
          : `The version to take next is ${now.next}: a version is taken one minor at a time`,
      );
    }
    if (await updater.busy()) {
      throw new ApiFailure('conflict', 'The updater is taking a version now');
    }
    await updater.request(asked.body);
    await audit.record({
      by: refOf(asked),
      action: 'update.request',
      detail: {
        version: asked.body.version,
        action: asked.body.action,
        ...(asked.body.at == null ? {} : { at: asked.body.at }),
      },
    });
    return updatesOf(parts);
  },
  'updates.cancel': async (asked, parts) => {
    const { updater, audit } = parts;
    if (updater === undefined || !(await updater.alive())) throw noUpdater();
    if (await updater.busy()) {
      throw new ApiFailure('conflict', 'The updater is taking a version now: it is not stopped');
    }
    await updater.cancel();
    await audit.record({ by: refOf(asked), action: 'update.cancel' });
    return updatesOf(parts);
  },
};

/** A server with no updater beside it. */
const noUpdater = () =>
  new ApiFailure(
    'unavailable',
    'No updater is running beside this server: a version is taken where it runs',
  );

/** What there is after this version, and what the updater is doing. */
async function updatesOf(parts: Parts, refresh = false): Promise<Updates> {
  const updater = parts.updater === undefined ? null : await parts.updater.status();
  return (
    (await parts.updates?.status(refresh, updater)) ?? {
      current: parts.version ?? '',
      check: 'off',
      checkedAt: null,
      error: null,
      latest: null,
      next: null,
      releases: [],
      updater,
    }
  );
}

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
