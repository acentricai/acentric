// The API, route by route, called as a program calls it. Every answer is held to its route's
// schema by the server under test (see `api.ts`).

import { describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import { ApiError } from '@acentric/client';
import { makeId, routes } from '@acentric/protocol';
import type { ActorEvent } from '@acentric/protocol';

import { handlers } from '../src/handlers.ts';
import { ADMIN, BASE, MANIFEST, api, refusal } from './api.ts';

const lookup = calls({ id: 'c1', name: 'lookup_order', arguments: { id: 4411 } });
const nobody = <K extends 'agent' | 'actor' | 'key' | 'deployment'>(kind: K) =>
  makeId(kind, { now: 1_795_305_600_000, random: new Uint8Array(10).fill(9) });

describe('the server', () => {
  it('says it is up, and what its API is, to anyone', async () => {
    const { app } = await api();
    const health = await app.request('/health');
    expect(await health.json()).toEqual({ ok: true, version: 'test' });
    const document = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: { [path: string]: unknown };
    };
    expect(Object.keys(document.paths)).toContain('/v1/actors/{actor}/inputs');
  });

  it('answers what is no route as every failure is answered', async () => {
    const { app } = await api();
    const response = await app.request('/v1/nothing-here');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('has a handler for every route that is built, and says which are not yet', () => {
    const missing = Object.keys(routes).filter((id) => !Object.hasOwn(handlers, id));
    // People, their sessions and the audit log come with the part that adds people.
    expect(missing).toEqual([
      'users.list',
      'users.get',
      'users.update',
      'users.delete',
      'sessions.list',
      'sessions.revoke',
      'audit.list',
    ]);
  });

  it('says nothing of why when it fails itself, and tells whoever runs it', async () => {
    const { admin, engine, failures } = await api();
    engine.listAgents = () => Promise.reject(new Error('the disk is gone'));
    const failed = admin.call('agents.list');
    await expect(failed).rejects.toMatchObject({ code: 'internal', status: 500 });
    await expect(failed).rejects.toThrow('The server failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('the disk is gone');
    const error = (await failed.catch((caught: unknown) => caught)) as ApiError;
    expect(error.requestId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('who a request is from', () => {
  it('is said by its key', async () => {
    const { admin } = await api();
    expect(await admin.call('me.get')).toMatchObject({
      type: 'key',
      scope: { type: 'engine' },
      owner: null,
    });
  });

  it('is asked of every request: one with no key, or a wrong one, is refused', async () => {
    const { as } = await api();
    expect(await refusal(as().call('me.get'))).toEqual({ code: 'unauthenticated', status: 401 });
    expect(await refusal(as('not-a-key').call('agents.list'))).toEqual({
      code: 'unauthenticated',
      status: 401,
    });
    expect(await refusal(as(`${ADMIN}x`).call('me.get'))).toMatchObject({ status: 401 });
  });

  it('decides what the request may do: a key without a route’s permission is refused', async () => {
    const { deploy, keyed } = await api();
    const { agent } = await deploy();
    const reader = await keyed({ scope: { type: 'engine' }, permissions: ['agents:read'] });
    expect((await reader.client.call('agents.get', { params: { agent: agent.id } })).id).toBe(
      agent.id,
    );
    expect(
      await refusal(reader.client.call('actors.create', { params: { agent: agent.id }, body: {} })),
    ).toEqual({ code: 'forbidden', status: 403 });
    expect(await refusal(reader.client.call('keys.list'))).toEqual({
      code: 'forbidden',
      status: 403,
    });
  });

  it('decides what the request reaches: to a key, what it does not reach is not there', async () => {
    const { admin, deploy, keyed } = await api();
    const orders = (await deploy('orders')).agent;
    const billing = (await deploy('billing', 'billing@1')).agent;
    const mine = await admin.call('actors.create', { params: { agent: orders.id }, body: {} });
    const other = await admin.call('actors.create', { params: { agent: billing.id }, body: {} });
    const ofOrders = await keyed({
      scope: { type: 'agent', agent: orders.id },
      permissions: ['agents:read', 'actors:read', 'actors:write'],
    });
    const ofActor = await keyed({
      scope: { type: 'actor', actor: mine.actor.id },
      permissions: ['actors:read', 'actors:send'],
    });
    const { client } = ofOrders;

    expect((await client.call('actors.get', { params: { actor: mine.actor.id } })).id).toBe(
      mine.actor.id,
    );
    expect(await refusal(client.call('agents.get', { params: { agent: billing.id } }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(await refusal(client.call('actors.get', { params: { actor: other.actor.id } }))).toEqual(
      { code: 'not_found', status: 404 },
    );
    // Its lists hold what it reaches, whatever it asks for.
    expect((await client.call('agents.list')).items.map((agent) => agent.id)).toEqual([orders.id]);
    expect((await client.call('actors.list')).items.map((actor) => actor.id)).toEqual([
      mine.actor.id,
    ]);
    expect((await client.call('actors.list', { query: { agent: billing.id } })).items).toEqual([]);

    // A key for one actor reaches that actor, and nothing of its agent besides.
    expect((await ofActor.client.call('actors.list')).items.map((actor) => actor.id)).toEqual([
      mine.actor.id,
    ]);
    expect(
      await refusal(ofActor.client.call('actors.get', { params: { actor: other.actor.id } })),
    ).toMatchObject({ status: 404 });
  });
});

describe('a request that is not what its route takes', () => {
  it('is refused with each thing wrong with it, and where', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    const wrong = admin.call('actors.create', {
      params: { agent: agent.id },
      body: { reasoning: 'enormous', id: 'my-own' } as never,
    });
    await expect(wrong).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    const error = (await wrong.catch((caught: unknown) => caught)) as ApiError;
    expect(error.issues?.map((issue) => issue.path?.join('.'))).toEqual(
      expect.arrayContaining(['reasoning']) as never,
    );

    expect(
      await refusal(admin.call('agents.get', { params: { agent: 'orders' as never } })),
    ).toEqual({ code: 'invalid_request', status: 400 });
    expect(await refusal(admin.call('actors.list', { query: { limit: 0 } }))).toMatchObject({
      status: 400,
    });
  });

  it('is refused when its body is not JSON, or is larger than it may be', async () => {
    const { app } = await api();
    const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
    const notJson = await app.request(`${BASE}/v1/keys`, { method: 'POST', headers, body: '{' });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const large = await app.request(`${BASE}/v1/keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: { code: 'too_large' } });
  });
});

describe('agents and their versions', () => {
  it('are deployed: made the first time, a new version after, and nothing for the same code', async () => {
    const { admin, deploy } = await api();
    const first = await deploy();
    expect(first).toMatchObject({
      created: true,
      agent: { name: 'orders', provider: 'fake', activeDeployment: { version: 1 } },
      deployment: { version: 1, createdBy: { type: 'key' } },
      // The code names a secret that is not set yet.
      missingSecrets: ['ORDERS_API_KEY'],
    });
    expect((await deploy()).created).toBe(false);
    const second = await deploy('orders', 'orders@2');
    expect(second).toMatchObject({ created: true, deployment: { version: 2 } });
    expect(second.agent.id).toBe(first.agent.id);

    const listed = await admin.call('deployments.list', { params: { agent: first.agent.id } });
    expect(listed.items.map((deployment) => deployment.version)).toEqual([2, 1]);
    // A list has no definitions in it. One deployment, read alone, has its own.
    expect(listed.items[0]).not.toHaveProperty('definition');
    const read = await admin.call('deployments.get', {
      params: { agent: first.agent.id, deployment: second.deployment.id },
    });
    expect(read.definition.instructions).toBe('You are kind.');
  });

  it('answer a deploy 201 when something was made, and 200 when nothing was', async () => {
    const { app } = await api();
    const deploy = () =>
      app.request(`${BASE}/v1/deployments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'orders', manifest: MANIFEST, code: 'orders@1' }),
      });
    expect((await deploy()).status).toBe(201);
    expect((await deploy()).status).toBe(200);
  });

  it('refuse code that is not an agent, or uses what the engine has not', async () => {
    const { admin, deploy } = await api();
    expect(await refusal(deploy('orders', 'nothing@1'))).toEqual({
      code: 'invalid_agent',
      status: 400,
    });
    expect(await refusal(deploy('machines', 'machines@1'))).toEqual({
      code: 'unsupported_feature',
      status: 400,
    });
    expect(
      await refusal(
        admin.call('deployments.create', {
          body: { agent: 'orders', manifest: { protocol: 99, sdk: '9' }, code: 'orders@1' },
        }),
      ),
    ).toEqual({ code: 'unsupported_protocol', status: 400 });
    expect((await admin.call('agents.list')).items).toEqual([]);
  });

  it('are deployed to by a key of one agent, which makes no other', async () => {
    const { deploy, keyed } = await api();
    const { agent } = await deploy();
    const { client } = await keyed({
      scope: { type: 'agent', agent: agent.id },
      permissions: ['agents:deploy'],
    });
    expect((await deploy('orders', 'orders@2', client)).deployment.version).toBe(2);
    expect(await refusal(deploy('billing', 'billing@1', client))).toEqual({
      code: 'forbidden',
      status: 403,
    });
  });

  it('are listed a page at a time, found by name, and read', async () => {
    const { admin, deploy } = await api();
    const made = [];
    for (const name of ['orders', 'billing', 'returns']) {
      made.push((await deploy(name, 'orders@1')).agent.id);
    }
    const first = await admin.call('agents.list', { query: { limit: 2 } });
    expect(first.items.map((agent) => agent.id)).toEqual([made[2], made[1]]);
    const rest = await admin.call('agents.list', {
      query: { limit: 2, cursor: first.nextCursor ?? '' },
    });
    expect(rest).toMatchObject({ items: [{ id: made[0] }], nextCursor: null });

    expect((await admin.call('agents.list', { query: { name: 'billing' } })).items).toMatchObject([
      { id: made[1], name: 'billing' },
    ]);
    expect((await admin.call('agents.list', { query: { name: 'nobody' } })).items).toEqual([]);
    expect(await refusal(admin.call('agents.get', { params: { agent: nobody('agent') } }))).toEqual(
      {
        code: 'not_found',
        status: 404,
      },
    );
  });

  it('have a deploy taken back by making an older version the active one', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    await deploy('orders', 'orders@2');
    const back = await admin.call('agents.update', {
      params: { agent: agent.id },
      body: { activeVersion: 1 },
    });
    expect(back).toMatchObject({
      activeDeployment: { version: 1 },
      latestDeployment: { version: 2 },
    });
    expect(
      await refusal(
        admin.call('agents.update', { params: { agent: agent.id }, body: { activeVersion: 9 } }),
      ),
    ).toEqual({ code: 'not_found', status: 404 });
  });

  it('are deleted, with their actors', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    expect(await admin.call('agents.delete', { params: { agent: agent.id } })).toBeUndefined();
    expect(await refusal(admin.call('agents.get', { params: { agent: agent.id } }))).toMatchObject({
      status: 404,
    });
    expect(await refusal(admin.call('actors.get', { params: { actor: actor.id } }))).toMatchObject({
      status: 404,
    });
  });
});

describe('an agent’s secrets', () => {
  it('are set, listed by name and removed, and never read back', async () => {
    const { admin, deploy, secrets } = await api();
    const { agent } = await deploy();
    const params = { agent: agent.id, name: 'ORDERS_API_KEY' };
    expect(await admin.call('secrets.set', { params, body: { value: 'k-1' } })).toBeUndefined();
    await admin.call('secrets.set', {
      params: { agent: agent.id, name: 'BILLING_KEY' },
      body: { value: 'b-1' },
    });
    const listed = await admin.call('secrets.list', { params: { agent: agent.id } });
    expect(listed.items.map((secret) => secret.name)).toEqual(['BILLING_KEY', 'ORDERS_API_KEY']);
    expect(JSON.stringify(listed)).not.toContain('k-1');
    // The agent's code is what reads it.
    expect(await secrets.get(agent.id, 'ORDERS_API_KEY')).toBe('k-1');
    // Deployed again, the code is told nothing is missing but what is.
    expect((await deploy('orders', 'orders@2')).missingSecrets).toEqual([]);

    expect(await admin.call('secrets.delete', { params })).toBeUndefined();
    expect(await refusal(admin.call('secrets.delete', { params }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(
      await refusal(
        admin.call('secrets.set', {
          params: { agent: agent.id, name: 'not-a-name' as never },
          body: { value: 'x' },
        }),
      ),
    ).toMatchObject({ status: 400 });
  });

  it('are refused by a server that was given no key to seal them with', async () => {
    const { admin, deploy } = await api([], { secretKey: false });
    const { agent } = await deploy();
    expect(
      await refusal(
        admin.call('secrets.set', {
          params: { agent: agent.id, name: 'ORDERS_API_KEY' },
          body: { value: 'k-1' },
        }),
      ),
    ).toEqual({ code: 'unavailable', status: 503 });
  });
});

describe('actors', () => {
  it('are created on an agent, once for the caller’s own ID', async () => {
    const { app, admin, deploy } = await api();
    const { agent } = await deploy();
    const first = await admin.call('actors.create', {
      params: { agent: agent.id },
      body: { name: 'eu-desk', externalId: 'telegram:4411', reasoning: 'high' },
    });
    expect(first).toMatchObject({
      created: true,
      actor: {
        name: 'eu-desk',
        externalId: 'telegram:4411',
        agent: agent.id,
        deployment: { version: 1 },
        pinned: false,
        modelId: 'fake-1',
        reasoning: 'high',
        status: 'idle',
      },
    });
    const create = (body: unknown) =>
      app.request(`${BASE}/v1/agents/${agent.id}/actors`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const again = await create({ externalId: 'telegram:4411' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, actor: { id: first.actor.id } });
    expect((await create({})).status).toBe(201);

    expect(
      await refusal(
        admin.call('actors.create', { params: { agent: agent.id }, body: { name: 'eu-desk' } }),
      ),
    ).toEqual({ code: 'name_taken', status: 409 });
    expect(
      await refusal(
        admin.call('actors.create', {
          params: { agent: agent.id },
          body: { configuration: { region: 'eu' } },
        }),
      ),
    ).toEqual({ code: 'invalid_configuration', status: 400 });
  });

  it('are listed newest first, a page at a time, and narrowed', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    const made = [];
    for (const name of ['one', 'two', 'three']) {
      const { actor } = await admin.call('actors.create', {
        params: { agent: agent.id },
        body: { name },
      });
      made.push(actor.id);
    }
    const first = await admin.call('actors.list', { query: { limit: 2 } });
    expect(first.items.map((actor) => actor.id)).toEqual([made[2], made[1]]);
    const rest = await admin.call('actors.list', {
      query: { limit: 2, cursor: first.nextCursor ?? '' },
    });
    expect(rest).toMatchObject({ items: [{ id: made[0] }], nextCursor: null });
    expect(
      (await admin.call('actors.list', { query: { agent: agent.id, name: 'two' } })).items,
    ).toMatchObject([{ id: made[1] }]);
    await admin.call('actors.archive', { params: { actor: made[0] as never } });
    expect(
      (await admin.call('actors.list', { query: { status: 'archived' } })).items.map(
        (actor) => actor.id,
      ),
    ).toEqual([made[0]]);
  });

  it('are changed between turns: their name, model, reasoning and version', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    await deploy('orders', 'orders@2');
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const changed = await admin.call('actors.update', {
      params: { actor: actor.id },
      body: { name: 'eu-desk', reasoning: 'high', version: 1 },
    });
    expect(changed).toMatchObject({
      name: 'eu-desk',
      reasoning: 'high',
      deployment: { version: 1 },
      pinned: true,
    });
    expect(
      await refusal(
        admin.call('actors.update', { params: { actor: actor.id }, body: { version: 9 } }),
      ),
    ).toEqual({ code: 'not_found', status: 404 });
  });

  it('are put away and taken out again, and take nothing while they are away', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    expect((await admin.call('actors.archive', { params })).status).toBe('archived');
    expect(
      await refusal(
        admin.call('inputs.send', { params, body: { type: 'message', payload: { text: 'Hi' } } }),
      ),
    ).toEqual({ code: 'actor_archived', status: 409 });
    expect(await refusal(admin.call('actors.update', { params, body: { name: 'x' } }))).toEqual({
      code: 'actor_archived',
      status: 409,
    });
    expect((await admin.call('actors.unarchive', { params })).status).toBe('idle');
    // A turn that did not fail is not one to try again.
    expect(await refusal(admin.call('actors.retry', { params }))).toEqual({
      code: 'conflict',
      status: 409,
    });
  });
});

describe('a conversation', () => {
  it('is a message sent, a turn taken, and the messages read back', async () => {
    const { admin, deploy, say } = await api([lookup, says('It was refunded twice.')]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const sent = await say(actor.id, 'Why two refunds?');
    expect(sent.status).toBe('accepted');

    const read = await admin.call('messages.list', { params: { actor: actor.id } });
    expect(read.items.map((entry) => [entry.seq, entry.message.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'tool_result'],
      [4, 'assistant'],
    ]);
    expect(read.nextCursor).toBeNull();
    expect(await admin.call('actors.get', { params: { actor: actor.id } })).toMatchObject({
      status: 'idle',
      lastTurn: { end: 'ok' },
      pendingInputs: 0,
    });
    const inputs = await admin.call('inputs.list', { params: { actor: actor.id } });
    expect(inputs.items).toMatchObject([{ id: sent.input, type: 'message' }]);
    expect(inputs.items[0]?.deliveredAt).not.toBeNull();
    expect(
      (await admin.call('inputs.list', { params: { actor: actor.id }, query: { pending: true } }))
        .items,
    ).toEqual([]);
  });

  it('answers a send 202, once the input is stored', async () => {
    const { app, admin, deploy } = await api([says('Hello.')]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const response = await app.request(`${BASE}/v1/actors/${actor.id}/inputs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', payload: { text: 'Hello?' }, externalId: 'm-1' }),
    });
    expect(response.status).toBe(202);
    // Sent again with the same ID of the caller's, nothing more is stored.
    const again = await admin.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: 'message', payload: { text: 'Hello?' }, externalId: 'm-1' },
    });
    expect(again.status).toBe('duplicate');
  });

  it('is read from either end, a page at a time', async () => {
    const { admin, deploy, say } = await api([says('One.'), says('Two.'), says('Three.')]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    for (const text of ['First.', 'Second.', 'Third.']) await say(actor.id, text);
    const params = { actor: actor.id };
    const seqs = async (query: Parameters<typeof admin.call<'messages.list'>>[1]['query']) => {
      const page = await admin.call('messages.list', { params, ...(query ? { query } : {}) });
      return { seqs: page.items.map((entry) => entry.seq), next: page.nextCursor };
    };

    const newest = await seqs({ order: 'desc', limit: 4 });
    expect(newest).toEqual({ seqs: [6, 5, 4, 3], next: '3' });
    expect(await seqs({ order: 'desc', limit: 4, cursor: newest.next ?? '' })).toEqual({
      seqs: [2, 1],
      next: null,
    });
    const oldest = await seqs({ limit: 4 });
    expect(oldest).toEqual({ seqs: [1, 2, 3, 4], next: '4' });
    expect(await seqs({ limit: 4, cursor: oldest.next ?? '' })).toEqual({
      seqs: [5, 6],
      next: null,
    });
    expect((await seqs({ after: 4 })).seqs).toEqual([5, 6]);
    expect(await refusal(admin.call('messages.list', { params, query: { cursor: 'x' } }))).toEqual({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('refuses an input the agent has none of, and one its code refuses', async () => {
    const { admin, deploy } = await api();
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    expect(
      await refusal(admin.call('inputs.send', { params, body: { type: 'github.push' } })),
    ).toEqual({ code: 'unknown_input', status: 400 });
    expect(
      await refusal(
        admin.call('inputs.send', { params, body: { type: 'message', payload: { text: 5 } } }),
      ),
    ).toEqual({ code: 'invalid_input', status: 400 });
  });

  it('is ended in the middle of a turn by an interrupt', async () => {
    const { admin, deploy, engine } = await api([() => new Promise(() => {})]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const params = { actor: actor.id };
    await admin.call('inputs.send', { params, body: { type: 'message', payload: { text: 'Hi' } } });
    // Busy: what is done only between turns is refused.
    await expect
      .poll(async () => (await admin.call('actors.get', { params })).status)
      .toBe('working');
    expect(await refusal(admin.call('actors.update', { params, body: { name: 'x' } }))).toEqual({
      code: 'actor_busy',
      status: 409,
    });
    expect(await admin.call('actors.interrupt', { params })).toMatchObject({
      status: 'idle',
      lastTurn: { end: 'interrupted' },
    });
    await engine.close({ graceMs: 0 });
  });
});

describe('following an actor', () => {
  /** Reads events until `done` says so, then stops following. */
  const follow = async (
    events: AsyncIterable<ActorEvent>,
    stop: AbortController,
    done: (seen: ActorEvent[]) => boolean,
  ) => {
    const seen: ActorEvent[] = [];
    for await (const event of events) {
      seen.push(event);
      if (done(seen)) stop.abort();
    }
    return seen;
  };
  const idleAfterWork = (seen: ActorEvent[]) =>
    seen.some((event) => event.type === 'status' && event.status === 'working') &&
    seen.at(-1)?.type === 'status' &&
    (seen.at(-1) as { status: string }).status === 'idle';

  it('is sent where it stands, then each message as it is stored, then that it is idle', async () => {
    const { admin, deploy, streams } = await api([lookup, says('It was refunded twice.')]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const stop = new AbortController();
    const following = follow(admin.events(actor.id, { signal: stop.signal }), stop, idleAfterWork);
    await expect.poll(() => streams.size).toBe(1);
    await admin.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: 'message', payload: { text: 'Why two refunds?' } },
    });

    const seen = await following;
    expect(seen[0]).toMatchObject({ type: 'status', status: 'idle', pendingInputs: 0 });
    const messages = seen.flatMap((event) => (event.type === 'message' ? [event.entry] : []));
    expect(messages.map((entry) => [entry.seq, entry.message.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'tool_result'],
      [4, 'assistant'],
    ]);
    // Told the actor is idle, a follower has every message of the turn that ended.
    expect(seen.at(-1)).toMatchObject({ type: 'status', status: 'idle', lastTurn: { end: 'ok' } });
    // The stream is given up, and the server keeps nothing of it.
    await expect.poll(() => streams.size).toBe(0);
  });

  it('is caught up from where one left off, by the query or as a browser says it', async () => {
    const { app, admin, deploy, say } = await api([says('One.'), says('Two.')]);
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    await say(actor.id, 'First.');
    await say(actor.id, 'Second.');

    const stop = new AbortController();
    const seen = await follow(
      admin.events(actor.id, { after: 2, signal: stop.signal }),
      stop,
      (events) => events.at(-1)?.type === 'status',
    );
    expect(seen.map((event) => (event.type === 'message' ? event.entry.seq : event.type))).toEqual([
      3,
      4,
      'status',
    ]);

    // A browser that comes back says the ID of the last event it saw.
    const controller = new AbortController();
    const response = await app.request(`${BASE}/v1/actors/${actor.id}/events`, {
      headers: { authorization: `Bearer ${ADMIN}`, 'last-event-id': '3' },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('event: status')) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toMatch(/^event: message\nid: 4\ndata: \{.*\}\n\nevent: status\n/);
    expect(text).not.toContain('id: 3');
  });

  it('is ended when the server stops', async () => {
    const { admin, deploy, streams } = await api();
    const { agent } = await deploy();
    const { actor } = await admin.call('actors.create', { params: { agent: agent.id }, body: {} });
    const seen: ActorEvent[] = [];
    const following = (async () => {
      for await (const event of admin.events(actor.id)) seen.push(event);
    })();
    await expect.poll(() => seen.length).toBe(1);
    streams.close();
    await following;
    expect(streams.size).toBe(0);
  });
});

describe('API keys', () => {
  it('are made with a token shown once, which a request is then from', async () => {
    const { admin, as, deploy } = await api();
    const { agent } = await deploy();
    const made = await admin.call('keys.create', {
      body: {
        label: 'for the support service',
        scope: { type: 'agent', agent: agent.id },
        permissions: ['actors:read', 'actors:write', 'actors:send', 'keys:manage'],
      },
    });
    expect(made.token).toMatch(/^ak_/);
    // What comes after the key's ID is its secret, which may have a `_` of its own in it.
    expect(JSON.stringify(made.key)).not.toContain(
      made.token.slice(made.token.indexOf('_', 3) + 1),
    );
    const service = as(made.token);
    expect(await service.call('me.get')).toMatchObject({
      type: 'key',
      key: made.key.id,
      scope: { type: 'agent', agent: agent.id },
    });
    expect((await admin.call('keys.get', { params: { key: made.key.id } })).label).toBe(
      'for the support service',
    );
  });

  it('make keys no wider than themselves: a service hands a client a key for one actor', async () => {
    const { admin, as, deploy, keyed } = await api();
    const { agent } = await deploy();
    const service = await keyed({
      scope: { type: 'agent', agent: agent.id },
      permissions: ['actors:read', 'actors:write', 'actors:send', 'keys:manage'],
    });
    const { actor } = await service.client.call('actors.create', {
      params: { agent: agent.id },
      body: {},
    });
    const handed = await service.client.call('keys.create', {
      body: {
        label: 'for one customer',
        scope: { type: 'actor', actor: actor.id },
        permissions: ['actors:read', 'actors:send'],
      },
    });
    const customer = as(handed.token);
    expect((await customer.call('actors.get', { params: { actor: actor.id } })).id).toBe(actor.id);
    expect(await refusal(customer.call('agents.get', { params: { agent: agent.id } }))).toEqual({
      code: 'forbidden',
      status: 403,
    });

    expect(
      await refusal(
        service.client.call('keys.create', {
          body: { label: 'too wide', scope: { type: 'engine' }, permissions: ['actors:read'] },
        }),
      ),
    ).toEqual({ code: 'forbidden', status: 403 });
    expect(
      await refusal(
        admin.call('keys.create', {
          body: {
            label: 'what an actor’s key cannot hold',
            scope: { type: 'actor', actor: actor.id },
            permissions: ['agents:deploy'],
          },
        }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
  });

  it('are listed a page at a time, and revoked with every key they made', async () => {
    const { admin, as, keyed } = await api();
    const manage = ['keys:manage', 'actors:read'] as const;
    const parent = await keyed({ scope: { type: 'engine' }, permissions: [...manage] });
    const child = await parent.client.call('keys.create', {
      body: { label: 'a child', scope: { type: 'engine' }, permissions: ['actors:read'] },
    });
    const other = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });

    const first = await admin.call('keys.list', { query: { limit: 2 } });
    expect(first.items.map((key) => key.id)).toEqual([parent.key.id, child.key.id]);
    const rest = await admin.call('keys.list', {
      query: { limit: 2, cursor: first.nextCursor ?? '' },
    });
    expect(rest).toMatchObject({ items: [{ id: other.key.id }], nextCursor: null });

    expect(await admin.call('keys.revoke', { params: { key: parent.key.id } })).toBeUndefined();
    expect(await refusal(as(parent.token).call('me.get'))).toMatchObject({ status: 401 });
    expect(await refusal(as(child.token).call('me.get'))).toMatchObject({ status: 401 });
    expect((await other.client.call('me.get')).type).toBe('key');
    expect(await refusal(admin.call('keys.get', { params: { key: nobody('key') } }))).toEqual({
      code: 'not_found',
      status: 404,
    });
  });
});
