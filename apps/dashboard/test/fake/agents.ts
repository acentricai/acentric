// The fake server's routes of the dashboard's agents area: agents, their deployments and
// secrets, and actors with their conversations, tasks and mailboxes, as the server answers them.
// Actors are kept with the server's own, in `shared.actors`, which the machines pages read too.

import type {
  Actor,
  ActorEvent,
  Agent,
  AgentDefinition,
  Compaction,
  ConversationEntry,
  Deployment,
  Input,
  TaskDetail,
  UsageTotals,
} from '@acentric/protocol';

import { json, refused, type Area, type Call, type Shared } from './area.ts';

const NOW = 1_795_305_600_000;

/** An ID of a kind, from a number: the same for the same number. */
export const idOf = (prefix: string, n: number) =>
  `${prefix}_${'0'.repeat(25 - String(n).length)}${String(n)}0`.slice(0, prefix.length + 27);

/** A definition as an agent's code says it, with what a test gives. */
export function definitionOf(more: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    provider: 'openai',
    instructions: 'You answer questions about orders.',
    configuration: null,
    tools: [],
    inputs: [{ type: 'message', schema: null }],
    ...more,
  };
}

const totalsOf = (cost: number, calls: number): UsageTotals => ({
  calls,
  failed: 0,
  totalInput: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  webSearches: 0,
  cost,
  estimatedCost: 0,
  unpriced: 0,
  durationMs: 0,
  medianMs: null,
  p95Ms: null,
  first: null,
  last: null,
});

/** An actor of an agent, idle, as one just made. */
export function actorFor(agent: Agent, n: number, more: Partial<Actor> = {}): Actor {
  return {
    id: idOf('act', n) as Actor['id'],
    name: null,
    externalId: null,
    agent: agent.id,
    deployment: agent.activeDeployment,
    pinned: false,
    behind: null,
    account: null,
    modelId: 'gpt-6.2-sol',
    reasoning: 'medium',
    configuration: null,
    machine: null,
    parent: null,
    status: 'idle',
    lastTurn: null,
    pendingInputs: 0,
    createdAt: NOW - n,
    archivedAt: null,
    ...more,
  };
}

export function agentsArea(shared: Shared) {
  const agents: Agent[] = [];
  const deployments: Deployment[] = [];
  const secrets = new Map<string, { name: string; updatedAt: number }[]>();
  const conversations = new Map<string, ConversationEntry[]>();
  const waiting = new Map<string, Input[]>();
  const tasks = new Map<string, TaskDetail[]>();
  const compactions = new Map<string, Compaction[]>();
  const spent = new Map<string, number>();
  /** The streams that follow each actor: an event sent to an actor reaches each. */
  const streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
  const sent: { actor: string; body: Record<string, unknown> }[] = [];
  let made = 100;

  const actor = (id: string) => shared.actors.find((one) => one.id === id);
  const encoder = new TextEncoder();
  const frame = (event: ActorEvent): Uint8Array =>
    encoder.encode(
      `event: ${event.type}\n${event.type === 'message' ? `id: ${String(event.entry.seq)}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    );
  const statusOf = (one: Actor): ActorEvent => ({
    type: 'status',
    status: one.status,
    lastTurn: one.lastTurn,
    pendingInputs: one.pendingInputs,
  });

  /** Sends an event to every stream that follows the actor. */
  const emit = (id: string, event: ActorEvent) => {
    for (const controller of streams.get(id) ?? []) controller.enqueue(frame(event));
  };

  const actorRoutes = (call: Call, one: Actor, rest: string): Response | undefined => {
    const { method } = call;
    if (method === 'GET' && rest === '') return json(200, one);
    if (method === 'GET' && rest === '/events') {
      const after = Number(call.query.get('after') ?? '0');
      const set = streams.get(one.id) ?? new Set();
      streams.set(one.id, set);
      let held: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          held = controller;
          set.add(controller);
          for (const entry of conversations.get(one.id) ?? []) {
            if (entry.seq > after) controller.enqueue(frame({ type: 'message', entry }));
          }
          controller.enqueue(frame(statusOf(one)));
        },
        cancel() {
          if (held !== undefined) set.delete(held);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (method === 'GET' && rest === '/messages') {
      return json(200, { items: conversations.get(one.id) ?? [], nextCursor: null });
    }
    if (method === 'GET' && rest === '/inputs') {
      return json(200, { items: waiting.get(one.id) ?? [], nextCursor: null });
    }
    if (method === 'POST' && rest === '/inputs') {
      sent.push({ actor: one.id, body: call.body });
      return json(202, { input: idOf('in', sent.length), status: 'accepted' });
    }
    if (method === 'GET' && rest === '/tasks') {
      return json(200, {
        items: (tasks.get(one.id) ?? []).map(({ input: _input, result: _result, ...task }) => task),
      });
    }
    const task = /^\/tasks\/([^/]+)(\/stop)?$/.exec(rest);
    if (task !== null) {
      const found = (tasks.get(one.id) ?? []).find((each) => each.id === task[1]);
      if (found === undefined) return refused(404, 'not_found', 'There is no such task');
      if (method === 'GET' && task[2] === undefined) return json(200, found);
      if (method === 'POST' && task[2] === '/stop') {
        Object.assign(found, { status: 'stopped', stoppedBy: 'person', endedAt: NOW });
        return json(200, found);
      }
    }
    if (method === 'DELETE' && rest === '') {
      if (one.status !== 'archived') {
        return refused(409, 'conflict', `The actor ${one.id} is not archived`);
      }
      shared.actors.splice(shared.actors.indexOf(one), 1);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && rest === '/compactions') {
      return json(200, { items: compactions.get(one.id) ?? [] });
    }
    if (method === 'GET' && rest === '/subagents') {
      return json(200, { items: shared.actors.filter((each) => each.parent?.id === one.id) });
    }
    if (method === 'GET' && rest === '/usage') {
      return json(200, { totals: totalsOf(spent.get(one.id) ?? 0, spent.has(one.id) ? 1 : 0) });
    }
    if (method === 'PATCH' && rest === '') {
      const { version, env, ...more } = call.body as Record<string, unknown> & {
        version?: number | 'active';
        env?: Record<string, string>;
      };
      Object.assign(one, more);
      if (env !== undefined && one.machine !== null) {
        one.machine = { ...one.machine, env: Object.keys(env).toSorted() };
      }
      if (version !== undefined) {
        const agent = agents.find((each) => each.id === one.agent);
        const to =
          version === 'active'
            ? agent?.activeDeployment
            : deployments.find((each) => each.agent === one.agent && each.version === version);
        if (to !== undefined) one.deployment = { id: to.id, version: to.version };
        one.pinned = version !== 'active';
      }
      return json(200, one);
    }
    const action = /^\/(archive|unarchive|interrupt|abort|retry|compact)$/.exec(rest);
    if (method === 'POST' && action !== null) {
      const how = action[1];
      if (how === 'archive') Object.assign(one, { status: 'archived', archivedAt: NOW });
      if (how === 'unarchive') Object.assign(one, { status: 'idle', archivedAt: null });
      if (how === 'interrupt' || how === 'abort') {
        Object.assign(one, { status: 'idle', lastTurn: { end: 'interrupted', at: NOW } });
      }
      emit(one.id, statusOf(one));
      if (how === 'abort') {
        return json(200, { actor: one, interrupted: true, tasks: [], agents: [] });
      }
      if (how === 'compact') return json(200, { actor: one, compacted: null });
      return json(200, one);
    }
    return undefined;
  };

  const answer: Area['answer'] = (call) => {
    const { method, path, query } = call;
    if (method === 'GET' && path === '/v1/agents' && agents.length > 0) {
      const name = query.get('name');
      return json(200, {
        items: name === null ? agents : agents.filter((one) => one.name === name),
        nextCursor: null,
      });
    }
    if (method === 'GET' && path === '/v1/actors') {
      const items = shared.actors.filter(
        (one) =>
          (query.get('agent') === null || one.agent === query.get('agent')) &&
          (query.get('status') === null || one.status === query.get('status')) &&
          (query.get('name') === null || one.name === query.get('name')),
      );
      return json(200, { items, nextCursor: null });
    }
    // An actor's spending with its subagents: the LLM area answers the rest of usage.
    if (method === 'GET' && path === '/v1/usage' && query.get('root') !== null) {
      const root = query.get('root');
      const under = shared.actors.filter((one) => one.id === root || one.parent?.id === root);
      const cost = under.reduce((sum, one) => sum + (spent.get(one.id) ?? 0), 0);
      return json(200, { totals: totalsOf(cost, under.length) });
    }
    const ofActor = /^\/v1\/actors\/([^/]+)(.*)$/.exec(path);
    if (ofActor !== null) {
      const one = actor(ofActor[1] ?? '');
      if (one === undefined) return refused(404, 'not_found', 'There is no such actor');
      return actorRoutes(call, one, ofActor[2] ?? '');
    }

    const ofAgent = /^\/v1\/agents\/([^/]+)(.*)$/.exec(path);
    if (ofAgent === null) return undefined;
    const agent = agents.find((one) => one.id === ofAgent[1]);
    if (agent === undefined) return refused(404, 'not_found', 'There is no such agent');
    const rest = ofAgent[2] ?? '';
    if (method === 'GET' && rest === '') return json(200, agent);
    if (method === 'DELETE' && rest === '') {
      agents.splice(agents.indexOf(agent), 1);
      return json(204, null);
    }
    if (method === 'PATCH' && rest === '') {
      const { activeVersion, ...changes } = call.body as { activeVersion?: number };
      if (activeVersion !== undefined) {
        const chosen = deployments.find(
          (one) => one.agent === agent.id && one.version === activeVersion,
        );
        if (chosen === undefined) return refused(409, 'conflict', 'There is no such version');
        agent.activeDeployment = { id: chosen.id, version: chosen.version };
      }
      Object.assign(agent, changes);
      return json(200, agent);
    }
    if (method === 'GET' && rest === '/deployments') {
      const items = deployments
        .filter((one) => one.agent === agent.id)
        .toSorted((a, b) => b.version - a.version)
        .map(({ definition: _definition, ...summary }) => summary);
      return json(200, { items, nextCursor: null });
    }
    const deployment = /^\/deployments\/([^/]+)$/.exec(rest);
    if (method === 'GET' && deployment !== null) {
      const found = deployments.find((one) => one.id === deployment[1]);
      return found === undefined
        ? refused(404, 'not_found', 'There is no such deployment')
        : json(200, found);
    }
    const code = /^\/deployments\/([^/]+)\/code$/.exec(rest);
    if (method === 'GET' && code !== null) {
      const found = deployments.find((one) => one.id === code[1]);
      return found === undefined
        ? refused(404, 'not_found', 'There is no such deployment')
        : json(200, { code: `export default 'v${found.version}';` });
    }
    if (method === 'GET' && rest === '/secrets') {
      return json(200, { items: secrets.get(agent.id) ?? [] });
    }
    const secret = /^\/secrets\/([^/]+)$/.exec(rest);
    if (secret !== null) {
      const name = decodeURIComponent(secret[1] ?? '');
      const list = (secrets.get(agent.id) ?? []).filter((one) => one.name !== name);
      if (method === 'PUT') list.push({ name, updatedAt: NOW });
      secrets.set(agent.id, list);
      return json(204, null);
    }
    if (method === 'POST' && rest === '/actors') {
      made += 1;
      const body = call.body as Partial<Actor> & { machine?: { id: string; cwd: string } };
      const one = actorFor(agent, made, {
        name: (body.name as string | undefined) ?? null,
        ...(body.modelId === undefined ? {} : { modelId: body.modelId }),
        ...(body.account === undefined ? {} : { account: body.account }),
        ...(body.machine === undefined
          ? {}
          : { machine: { id: body.machine.id as never, cwd: body.machine.cwd, env: [] } }),
      });
      shared.actors.unshift(one);
      return json(201, { actor: one, created: true });
    }
    return undefined;
  };

  return {
    answer,
    agents,
    deployments,
    /** What each send of an input was sent with. */
    sent,
    /** An agent with its deployments, the newest active, each with the definition given. */
    agent(name: string, n: number, versions: AgentDefinition[] = [definitionOf()]): Agent {
      const versionsMade = versions.map((definition, index) => ({
        id: idOf('dep', n * 10 + index + 1) as Deployment['id'],
        agent: idOf('agt', n) as Agent['id'],
        version: index + 1,
        hash: String(index + 1)
          .repeat(64)
          .slice(0, 64),
        manifest: { protocol: 1, sdk: '0.15.0' },
        createdBy: { type: 'system' as const },
        createdAt: NOW - (versions.length - index) * 1000,
        definition,
      }));
      deployments.push(...versionsMade);
      const newest = versionsMade.at(-1);
      if (newest === undefined) throw new Error('an agent has a deployment');
      const ref = { id: newest.id, version: newest.version };
      const agent: Agent = {
        id: idOf('agt', n) as Agent['id'],
        name,
        provider: definitionOf().provider,
        activeDeployment: ref,
        latestDeployment: ref,
        createdAt: NOW - 86_400_000,
      };
      agents.push(agent);
      shared.agents.push({ id: agent.id, name });
      return agent;
    },
    secrets(agent: string, names: string[]) {
      secrets.set(
        agent,
        names.map((name) => ({ name, updatedAt: NOW })),
      );
    },
    /** An actor's conversation as it stands. */
    conversation(actorId: string, entries: ConversationEntry[]) {
      conversations.set(actorId, entries);
    },
    /** One more message of an actor's conversation, sent to whoever follows it. */
    say(actorId: string, entry: ConversationEntry) {
      conversations.set(actorId, [...(conversations.get(actorId) ?? []), entry]);
      emit(actorId, { type: 'message', entry });
    },
    /** Where an actor stands now, sent to whoever follows it. */
    stand(actorId: string, more: Partial<Actor>) {
      const one = actor(actorId);
      if (one === undefined) return;
      Object.assign(one, more);
      emit(actorId, statusOf(one));
    },
    waiting(actorId: string, inputs: Input[]) {
      waiting.set(actorId, inputs);
    },
    tasks(actorId: string, list: TaskDetail[]) {
      tasks.set(actorId, list);
    },
    compactions(actorId: string, list: Compaction[]) {
      compactions.set(actorId, list);
    },
    spent(actorId: string, dollars: number) {
      spent.set(actorId, dollars);
    },
  };
}
