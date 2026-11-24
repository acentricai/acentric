// Sandboxes, through the API: accounts at a provider are added and forgotten, sandboxes are
// made, listed and deleted, and one that sleeps is woken for what is asked of it from outside.
// The provider is one of the tests' own, whose sandboxes are daemons of the tests' own. The
// providers themselves are tested where they are written.

import { describe, expect, it } from 'vitest';

import { ProviderFailed } from '@acentric/core';
import type { Machines } from '@acentric/core';

import { FakeProvider } from '../../../packages/core/test/fake-provider.ts';
import { ADMIN, BASE, api, refusal } from './api.ts';

/** A server with a provider, and an account at it. */
async function withProvider(provider = new FakeProvider()) {
  const one = await api([], {
    machines: true,
    sandboxes: { providers: [provider], times: { waitMs: 2000, wakeMs: 300, tickMs: 3_600_000 } },
  });
  provider.machines = one.engine.machines as Machines;
  const account = await one.admin.call('sandboxProviders.create', {
    body: { kind: 'fake', name: 'main', apiKey: 'good-key' },
  });
  return { ...one, provider, account };
}

describe('an account at a provider of sandboxes', () => {
  it('is added by its key, listed without it, and forgotten', async () => {
    const { admin, account, provider, failures } = await withProvider();
    expect(account).toMatchObject({
      kind: 'fake',
      name: 'main',
      account: 'dev@example.com',
      sandboxes: 0,
    });
    expect(account.id).toMatch(/^prv_/);
    const listed = await admin.call('sandboxProviders.list');
    expect(listed.items).toEqual([account]);
    expect(JSON.stringify(listed)).not.toContain('good-key');

    expect(
      await refusal(
        admin.call('sandboxProviders.create', {
          body: { kind: 'fake', name: 'main', apiKey: 'good-key' },
        }),
      ),
    ).toEqual({ code: 'name_taken', status: 409 });
    // A key the provider refuses is the provider's failure, and one it does not take is the caller's.
    expect(
      await refusal(
        admin.call('sandboxProviders.create', {
          body: { kind: 'fake', name: 'other', apiKey: 'bad-key' },
        }),
      ),
    ).toEqual({ code: 'sandbox_provider_failed', status: 502 });
    for (const body of [
      { kind: 'fake', name: 'other' },
      { kind: 'nowhere', name: 'other', apiKey: 'good-key' },
    ]) {
      expect(await refusal(admin.call('sandboxProviders.create', { body }))).toEqual({
        code: 'invalid_request',
        status: 400,
      });
    }
    provider.fail = (call) =>
      call === 'whoami'
        ? new ProviderFailed('Fake answered 429', { status: 429, code: 'rate_limited' })
        : undefined;
    expect(
      await refusal(
        admin.call('sandboxProviders.create', {
          body: { kind: 'fake', name: 'other', apiKey: 'good-key' },
        }),
      ),
    ).toEqual({ code: 'rate_limited', status: 429 });

    await admin.call('sandboxProviders.delete', { params: { provider: account.id } });
    expect((await admin.call('sandboxProviders.list')).items).toEqual([]);
    expect(
      await refusal(admin.call('sandboxProviders.delete', { params: { provider: account.id } })),
    ).toEqual({ code: 'not_found', status: 404 });
    expect(failures).toEqual([]);
  });

  it('is for a key of the whole engine that manages machines, and is in the audit log', async () => {
    const { admin, keyed, account } = await withProvider();
    // A key for one agent cannot hold the permission at all: machines are the whole engine's.
    const { client } = await keyed({ scope: { type: 'engine' }, permissions: ['actors:read'] });
    expect(await refusal(client.call('sandboxProviders.list'))).toEqual({
      code: 'forbidden',
      status: 403,
    });
    expect(
      await refusal(
        client.call('sandboxes.create', { body: { provider: account.id, vcpu: 2, memoryGB: 4 } }),
      ),
    ).toEqual({ code: 'forbidden', status: 403 });
    const made = await admin.call('sandboxes.create', {
      body: { provider: account.id, vcpu: 2, memoryGB: 4, name: 'builder' },
    });
    await admin.call('sandboxes.delete', { params: { machine: made.machine.id } });
    await admin.call('sandboxProviders.delete', { params: { provider: account.id } });
    const log = await admin.call('audit.list', { query: { limit: 10 } });
    expect(
      log.items
        .filter((event) => event.action.startsWith('sandbox'))
        .map((event) => [event.action, event.target]),
    ).toEqual([
      ['sandbox_provider.delete', { type: 'sandbox_provider', id: account.id }],
      ['sandbox.delete', { type: 'machine', id: made.machine.id }],
      ['sandbox.create', { type: 'machine', id: made.machine.id }],
      ['sandbox_provider.create', { type: 'sandbox_provider', id: account.id }],
    ]);
    expect(JSON.stringify(log)).not.toContain('good-key');
  });
});

describe('a sandbox', () => {
  it('is made as a machine whose daemon dials where the request came to, listed, and deleted by either route', async () => {
    const { admin, account, provider, failures } = await withProvider();
    const made = await admin.call('sandboxes.create', {
      body: {
        provider: account.id,
        vcpu: 2,
        memoryGB: 4,
        name: 'builder',
        agents: '*',
        idleTimeoutSeconds: 120,
      },
    });
    expect(made).toMatchObject({
      provider: account.id,
      kind: 'fake',
      providerSandboxId: 'sbx-1',
      vcpu: 2,
      memoryGB: 4,
      idleTimeoutSeconds: 120,
      state: 'running',
      machine: { name: 'builder', agents: '*', online: true, provider: account.id },
    });
    expect(JSON.parse(provider.only.asked.provision)).toMatchObject({
      server: BASE,
      id: made.machine.id,
    });
    const params = { machine: made.machine.id };
    // It is a machine like any other.
    expect(await admin.call('machines.get', { params })).toEqual(made.machine);
    expect((await admin.call('sandboxProviders.list')).items[0]?.sandboxes).toBe(1);
    const second = await admin.call('sandboxes.create', {
      body: { provider: account.id, vcpu: 2, memoryGB: 4 },
    });
    provider.expire('sbx-2');
    const listed = await admin.call('sandboxProviders.sandboxes', {
      params: { provider: account.id },
    });
    expect(listed.items.map((one) => [one.machine.name, one.state])).toEqual([
      ['builder', 'running'],
      [second.machine.name, 'stopped'],
    ]);

    // An account that has sandboxes is not forgotten.
    expect(
      await refusal(admin.call('sandboxProviders.delete', { params: { provider: account.id } })),
    ).toEqual({ code: 'conflict', status: 409 });

    // Removing its machine deletes it at the provider too, as deleting the sandbox does.
    await admin.call('machines.delete', { params });
    await admin.call('sandboxes.delete', { params: { machine: second.machine.id } });
    expect(provider.asked('delete')).toEqual(['sbx-1', 'sbx-2']);
    expect((await admin.call('machines.list')).items).toEqual([]);
    expect(await refusal(admin.call('sandboxes.delete', { params }))).toEqual({
      code: 'not_found',
      status: 404,
    });
    expect(failures).toEqual([]);
  });

  it('is refused for what cannot be made, and not removed when its provider cannot be asked', async () => {
    const { admin, account, provider } = await withProvider();
    const body = { provider: account.id, vcpu: 2, memoryGB: 4 };
    for (const wrong of [
      { ...body, vcpu: 3 },
      { ...body, idleTimeoutSeconds: 30 },
      { ...body, wait: 500 },
      { ...body, size: 'large' },
    ]) {
      expect(await refusal(admin.call('sandboxes.create', { body: wrong as never }))).toEqual({
        code: 'invalid_request',
        status: 400,
      });
    }
    expect(
      await refusal(
        admin.call('sandboxes.create', {
          body: { ...body, provider: 'prv_00000000000000000000000000' },
        }),
      ),
    ).toEqual({ code: 'not_found', status: 404 });
    provider.missing = 'Sandboxes at Fake are not set up on this server';
    expect(await refusal(admin.call('sandboxes.create', { body }))).toEqual({
      code: 'unavailable',
      status: 503,
    });
    provider.missing = undefined;
    expect(provider.asked('create')).toEqual([]);

    const made = await admin.call('sandboxes.create', { body });
    // A machine someone enrolled is not a sandbox.
    const { machine } = await admin.call('machines.create', { body: { name: 'laptop' } });
    expect(machine.provider).toBeNull();
    expect(
      await refusal(admin.call('sandboxes.delete', { params: { machine: machine.id } })),
    ).toEqual({ code: 'not_found', status: 404 });
    provider.fail = (call) =>
      call === 'delete' ? new ProviderFailed('Fake could not be reached') : undefined;
    for (const route of ['sandboxes.delete', 'machines.delete'] as const) {
      expect(await refusal(admin.call(route, { params: { machine: made.machine.id } }))).toEqual({
        code: 'sandbox_provider_failed',
        status: 502,
      });
    }
    expect(
      (await admin.call('machines.get', { params: { machine: made.machine.id } })).online,
    ).toBe(true);
  });

  it('is refused a file larger than may be written at once, sent in chunks with no length', async () => {
    const { admin, app, account } = await withProvider();
    const made = await admin.call('sandboxes.create', {
      body: { provider: account.id, vcpu: 2, memoryGB: 4 },
    });
    let sent = 0;
    const MIB = new Uint8Array(1 << 20);
    // A body that never ends, as one could send: what is read of it is counted.
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += MIB.byteLength;
        controller.enqueue(MIB);
      },
    });
    const written = await app.request(`/v1/machines/${made.machine.id}/files?path=/tmp/big`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ADMIN}` },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(written.status).toBe(413);
    expect(await written.json()).toMatchObject({ error: { code: 'too_large' } });
    // It stopped reading once it was past 8 MiB, not at the end, which there is not.
    expect(sent).toBeLessThan(16 << 20);
  });

  it('is woken for a command or a file asked of it from outside, and answers 503 when it cannot be', async () => {
    const { admin, app, account, provider, engine } = await withProvider();
    const made = await admin.call('sandboxes.create', {
      body: { provider: account.id, vcpu: 2, memoryGB: 4 },
    });
    const params = { machine: made.machine.id };
    const { daemon } = provider.only;
    daemon.files.set('/etc/hostname', Buffer.from('box\n'));
    daemon.onRun = (run) => {
      daemon.end({ actor: String(run['actor']), task: String(run['task']) });
    };
    const sleeps = async () => {
      provider.expire('sbx-1');
      await engine.machines?.whenOffline(made.machine.id);
      provider.calls.length = 0;
    };

    await sleeps();
    const ran = await admin.call('machineCommands.run', { params, body: { command: 'echo hi' } });
    expect(ran.status).toBe('exited');
    expect(provider.asked('start')).toHaveLength(1);

    await sleeps();
    const read = () =>
      app.request(`/v1/machines/${made.machine.id}/files?path=/etc/hostname`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
    const file = await read();
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('box\n');
    expect(provider.asked('start')).toHaveLength(1);

    await sleeps();
    provider.boots = false;
    expect(
      await refusal(admin.call('machineCommands.run', { params, body: { command: 'echo hi' } })),
    ).toEqual({ code: 'sandbox_asleep', status: 503 });
    const asleep = await read();
    expect(asleep.status).toBe(503);
    expect(await asleep.json()).toMatchObject({ error: { code: 'sandbox_asleep' } });
  });
});
