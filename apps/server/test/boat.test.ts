// Boat as a provider, through the whole API: the provider itself, the engine's sandboxes and
// the routes, against what stands for Boat's API and for the daemon in a sandbox. It has not
// been run against Boat itself.

import { describe, expect, it } from 'vitest';

import type { Machines, Sandboxes } from '@acentric/core';
import type { MachineId } from '@acentric/protocol';
import { boat } from '@acentric/sandbox';

import { FakeDaemon } from '../../../packages/core/test/fake-daemon.ts';
import { fakeBoat } from '../../../packages/sandbox/test/fake-boat.ts';
import { BASE, api, refusal } from './api.ts';

/** A server whose sandboxes are made at a Boat of the tests' own, and an account there. */
async function withBoat(template: string | undefined = 'acentric') {
  const boatApi = fakeBoat();
  const one = await api([], {
    machines: true,
    sandboxes: {
      providers: [boat({ fetch: boatApi.fetch, ...(template === '' ? {} : { template }) })],
      times: { waitMs: 2000, wakeMs: 1000, tickMs: 3_600_000 },
    },
  });
  const machines = one.engine.machines as Machines;
  /** The daemon of each sandbox, by Boat's ID for it. */
  const daemons = new Map<string, FakeDaemon>();
  // A sandbox that starts runs its daemon: it enrols from the file Boat was given, the first time.
  boatApi.onStart = (sandbox, how) => {
    const given = JSON.parse(sandbox.files[0]?.content ?? '{}') as { id: MachineId; token: string };
    const daemon = daemons.get(sandbox.id) ?? new FakeDaemon();
    daemons.set(sandbox.id, daemon);
    void (async () => {
      if (how === 'created') {
        await machines.enrol(given.id, { token: given.token, publicKey: daemon.publicKey });
      }
      await daemon.connect(machines, given.id);
    })();
  };
  const account = await one.admin.call('sandboxProviders.create', {
    body: { kind: 'boat', name: 'team', apiKey: 'boat-key-1' },
  });
  return { ...one, boatApi, machines, daemons, account };
}

describe('a sandbox at Boat', () => {
  it('is made in an account added by its key, from the template, and is a machine once its daemon has enrolled', async () => {
    const { admin, boatApi, account, store, failures } = await withBoat();
    expect(account).toMatchObject({ kind: 'boat', name: 'team', account: 'dev@example.com' });
    // The key is kept sealed, and a key Boat refuses is not kept at all.
    expect(JSON.stringify(await store.listSandboxProviders())).not.toContain('boat-key-1');
    expect(
      await refusal(
        admin.call('sandboxProviders.create', {
          body: { kind: 'boat', name: 'other', apiKey: 'not-a-key' },
        }),
      ),
    ).toEqual({ code: 'sandbox_provider_failed', status: 502 });

    const made = await admin.call('sandboxes.create', {
      body: {
        provider: account.id,
        vcpu: 4,
        memoryGB: 8,
        name: 'builder',
        idleTimeoutSeconds: 900,
      },
    });
    expect(made).toMatchObject({
      kind: 'boat',
      providerSandboxId: 'sbx_1',
      vcpu: 4,
      memoryGB: 8,
      idleTimeoutSeconds: 900,
      state: 'running',
      machine: { name: 'builder', enrolled: true, online: true },
    });
    const [asked] = boatApi.callsOf('POST', /^\/sandboxes$/);
    expect(asked?.body).toMatchObject({
      from: 'acentric',
      type: 'default',
      ttlSeconds: 900,
      labels: { 'acentric.machine': made.machine.id, 'acentric.provider': account.id },
    });
    const [file] = (asked?.body?.['files'] ?? []) as { path: string; content: string }[];
    expect(file?.path).toBe('/home/user/.acentric-provision.json');
    expect(JSON.parse(file?.content ?? '')).toMatchObject({ server: BASE, id: made.machine.id });

    // A size Boat does not make is refused before Boat is asked.
    expect(
      await refusal(
        admin.call('sandboxes.create', { body: { provider: account.id, vcpu: 3, memoryGB: 4 } }),
      ),
    ).toEqual({ code: 'invalid_request', status: 400 });
    expect(boatApi.callsOf('POST', /^\/sandboxes$/)).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('sleeps when Boat stops it, is started again for a command, and has its timer set again while it is used', async () => {
    const { admin, boatApi, account, machines, daemons, engine } = await withBoat();
    const made = await admin.call('sandboxes.create', {
      body: { provider: account.id, vcpu: 2, memoryGB: 4 },
    });
    const params = { machine: made.machine.id };
    const daemon = daemons.get('sbx_1') as FakeDaemon;
    daemon.onRun = (run) => {
      daemon.end({ actor: String(run['actor']), task: String(run['task']) });
    };

    // Boat's timer ran out: the sandbox is stopped, and its daemon is gone.
    boatApi.archive('sbx_1');
    daemon.drop();
    await machines.whenOffline(made.machine.id);
    const listed = await admin.call('sandboxProviders.sandboxes', {
      params: { provider: account.id },
    });
    expect(listed.items.map((one) => one.state)).toEqual(['stopped']);

    const ran = await admin.call('machineCommands.run', { params, body: { command: 'echo hi' } });
    expect(ran.status).toBe('exited');
    expect(boatApi.callsOf('POST', /\/resume$/).map((call) => call.body)).toEqual([
      { ttlSeconds: 3600 },
    ]);

    // A command started on it: its timer is set again at the next look.
    await (engine.sandboxes as Sandboxes).keepAwake();
    expect(boatApi.callsOf('PATCH', /^\/sandboxes\/sbx_1$/).map((call) => call.body)).toEqual([
      { ttlSeconds: 3600 },
    ]);

    // Deleted, it is deleted at Boat, which is told its ID to confirm.
    await admin.call('sandboxes.delete', { params });
    expect(boatApi.callsOf('DELETE', /./)[0]?.headers.get('x-ascii-confirm-delete')).toBe('sbx_1');
    expect(boatApi.sandboxes.size).toBe(0);
    expect((await admin.call('machines.list')).items).toEqual([]);
  });

  it('is not made by a server that was not told the template, though an account can be added', async () => {
    const { admin, boatApi, account } = await withBoat('');
    expect(account.account).toBe('dev@example.com');
    expect(
      await refusal(
        admin.call('sandboxes.create', { body: { provider: account.id, vcpu: 2, memoryGB: 4 } }),
      ),
    ).toEqual({ code: 'unavailable', status: 503 });
    expect(boatApi.callsOf('POST', /^\/sandboxes$/)).toEqual([]);
  });
});
