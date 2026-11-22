// Machines, through the API: they are added, enrolled by what stands for a daemon, changed and
// removed, and actors are created on them. A daemon's connection is tested with the daemon
// itself (see `daemon.test.ts`).

import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { says } from '@acentric/ai/testing';

import { ADMIN, BASE, api, refusal } from './api.ts';

/** The public half of a new key, as a daemon enrols with it. */
const publicKey = (): string =>
  generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');

describe('a machine', () => {
  it('is added with a token, read, listed, changed and removed', async () => {
    const one = await api([], { machines: true });
    const { admin, deploy, failures } = one;
    const { agent } = await deploy('workers', 'machines@1');

    const added = await admin.call('machines.create', { body: { name: 'build-box' } });
    expect(added.machine).toMatchObject({
      name: 'build-box',
      agents: [],
      enrolled: false,
      online: false,
      os: null,
      current: null,
    });
    expect(added.token).toMatch(/^[0-9a-f]{64}$/);
    expect(added.expiresAt).toBeGreaterThan(Date.now());
    const params = { machine: added.machine.id };

    expect(await refusal(admin.call('machines.create', { body: { name: 'build-box' } }))).toEqual({
      code: 'name_taken',
      status: 409,
    });
    expect(await admin.call('machines.get', { params })).toEqual(added.machine);
    await admin.call('machines.create', { body: { name: 'spare', agents: '*' } });
    expect((await admin.call('machines.list')).items.map((machine) => machine.name)).toEqual([
      'build-box',
      'spare',
    ]);
    expect(
      (await admin.call('machines.list', { query: { name: 'spare' } })).items.map(
        (machine) => machine.agents,
      ),
    ).toEqual(['*']);
    expect((await admin.call('machines.list', { query: { name: 'none' } })).items).toEqual([]);

    const changed = await admin.call('machines.update', {
      params,
      body: { name: 'builder', agents: [agent.id] },
    });
    expect(changed).toMatchObject({ name: 'builder', agents: [agent.id] });
    expect(
      await refusal(admin.call('machines.update', { params, body: { name: 'spare' } })),
    ).toEqual({ code: 'name_taken', status: 409 });

    // A new token, for a daemon that is to enrol again. The first no longer works.
    const again = await admin.call('machines.token', { params });
    expect(again.token).not.toBe(added.token);
    expect(again.machine).toMatchObject({ name: 'builder' });

    await admin.call('machines.delete', { params });
    for (const call of [
      admin.call('machines.get', { params }),
      admin.call('machines.delete', { params }),
      admin.call('machines.token', { params }),
      admin.call('machines.update', { params, body: { agents: '*' } }),
      admin.call('machines.upgrade', { params }),
    ]) {
      expect(await refusal(call)).toEqual({ code: 'not_found', status: 404 });
    }
    expect((await admin.call('audit.list')).items.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'machine.create',
        'machine.update',
        'machine.token',
        'machine.delete',
      ]),
    );
    expect(failures).toEqual([]);
  });

  it('is enrolled by its daemon, with its token and no key, once', async () => {
    const one = await api([], { machines: true });
    const { admin, as, failures } = one;
    const added = await admin.call('machines.create', { body: { name: 'box' } });
    const params = { machine: added.machine.id };
    const daemon = as();

    expect(
      await refusal(
        daemon.call('machines.enrol', { params, body: { token: 'no', publicKey: publicKey() } }),
      ),
    ).toEqual({ code: 'forbidden', status: 403 });
    expect(
      await refusal(
        daemon.call('machines.enrol', { params, body: { token: added.token, publicKey: 'AAAA' } }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    expect(
      await daemon.call('machines.enrol', {
        params,
        body: { token: added.token, publicKey: publicKey() },
      }),
    ).toEqual({ id: added.machine.id });
    expect(await admin.call('machines.get', { params })).toMatchObject({
      enrolled: true,
      online: false,
    });
    // The token worked once.
    expect(
      await refusal(
        daemon.call('machines.enrol', {
          params,
          body: { token: added.token, publicKey: publicKey() },
        }),
      ),
    ).toEqual({ code: 'forbidden', status: 403 });
    // Its token is no key: it reads nothing.
    expect(await refusal(as(added.token).call('machines.get', { params }))).toEqual({
      code: 'unauthenticated',
      status: 401,
    });
    // Its daemon is not connected: there is nothing to ask of it.
    expect(await refusal(admin.call('machines.upgrade', { params }))).toEqual({
      code: 'machine_offline',
      status: 409,
    });
    expect((await admin.call('audit.list', { query: { action: 'machine.enrol' } })).items).toEqual([
      expect.objectContaining({
        by: { type: 'system' },
        target: { type: 'machine', id: added.machine.id },
      }),
    ]);
    expect(failures).toEqual([]);
  });

  it('is kept by those who may: a key of the whole engine with machines:manage', async () => {
    const one = await api([], { machines: true });
    const { admin, deploy, keyed } = one;
    const { agent } = await deploy();
    const added = await admin.call('machines.create', { body: { name: 'box' } });
    const params = { machine: added.machine.id };

    const reader = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });
    const ofAgent = await keyed({
      scope: { type: 'agent', agent: agent.id },
      permissions: ['actors:read', 'actors:write'],
    });
    for (const { client } of [reader, ofAgent]) {
      for (const call of [
        client.call('machines.list'),
        client.call('machines.get', { params }),
        client.call('machines.create', { body: { name: 'other' } }),
        client.call('machines.update', { params, body: { agents: '*' } }),
        client.call('machines.token', { params }),
        client.call('machines.delete', { params }),
      ]) {
        expect(await refusal(call)).toEqual({ code: 'forbidden', status: 403 });
      }
    }
    const keeper = await keyed({ scope: { type: 'engine' }, permissions: ['machines:manage'] });
    expect((await keeper.client.call('machines.list')).items).toHaveLength(1);
    expect(await refusal(one.as().call('machines.list'))).toEqual({
      code: 'unauthenticated',
      status: 401,
    });
  });

  it('is not there on an engine that keeps none', async () => {
    const one = await api();
    expect(await refusal(one.admin.call('machines.list'))).toEqual({
      code: 'not_found',
      status: 404,
    });
    const response = await one.app.request(`${BASE}/v1/machines`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'box' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('an actor on a machine', () => {
  it('is created on one that is for its agent, with variables that are answered by name', async () => {
    const one = await api([says('Hello.')], { machines: true });
    const { admin, deploy, say, runner, failures } = one;
    const { agent } = await deploy('workers', 'machines@1');
    const added = await admin.call('machines.create', { body: { name: 'box' } });
    const machine = { id: added.machine.id, cwd: '~/work' };
    const create = (body: object) =>
      admin.call('actors.create', { params: { agent: agent.id }, body: body as never });

    expect(await refusal(create({}))).toEqual({ code: 'invalid_request', status: 400 });
    // The machine is for no agent until it is said which.
    expect(await refusal(create({ machine }))).toEqual({ code: 'invalid_request', status: 400 });
    expect(await refusal(create({ machine: { ...machine, cwd: 'work' } }))).toEqual({
      code: 'invalid_request',
      status: 400,
    });
    await admin.call('machines.update', {
      params: { machine: machine.id },
      body: { agents: [agent.id] },
    });
    const { actor } = await create({
      machine: { ...machine, env: { TOKEN: 'sk-secret', A: '1' } },
    });
    expect(actor.machine).toEqual({ ...machine, env: ['A', 'TOKEN'] });
    expect(
      JSON.stringify(await admin.call('actors.get', { params: { actor: actor.id } })),
    ).not.toContain('sk-secret');

    // Its variables alone are changed, in place of all it had.
    const changed = await admin.call('actors.update', {
      params: { actor: actor.id },
      body: { env: { OTHER: '2' } },
    });
    expect(changed.machine).toEqual({ ...machine, env: ['OTHER'] });
    // With something else, both are changed.
    const both = await admin.call('actors.update', {
      params: { actor: actor.id },
      body: { name: 'worker-1', env: {} },
    });
    expect(both).toMatchObject({ name: 'worker-1', machine: { ...machine, env: [] } });

    await say(actor.id, 'Hello.');
    expect(runner.steps[0]?.tools.map((tool) => tool.name)).toEqual([
      'lookup_order',
      'bash',
      'stop',
    ]);
    expect(runner.steps[0]?.instructions).toContain('Your working directory is ~/work.');

    // An actor of an agent that says nothing of a machine is given none, and has no variables.
    const plain = await deploy();
    expect(
      await refusal(
        admin.call('actors.create', { params: { agent: plain.agent.id }, body: { machine } }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    const { actor: other } = await admin.call('actors.create', {
      params: { agent: plain.agent.id },
      body: {},
    });
    expect(other.machine).toBeNull();
    expect(
      await refusal(
        admin.call('actors.update', { params: { actor: other.id }, body: { env: { A: '1' } } }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    expect(failures).toEqual([]);
  });
});
