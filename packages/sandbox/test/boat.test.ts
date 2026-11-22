// Boat as a provider, against what stands for Boat's API (see `fake-boat.ts`): what it asks
// of Boat, and what it makes of Boat's answers. It has not been run against Boat itself.

import { beforeEach, describe, expect, it } from 'vitest';

import { BOAT_PROVISION_PATH, ProviderFailed, boat, boatState } from '../src/index.ts';
import type { NewSandbox } from '../src/index.ts';
import { fakeBoat } from './fake-boat.ts';
import type { FakeBoat } from './fake-boat.ts';

let api: FakeBoat;
const provider = (template = 'acentric') => boat({ fetch: api.fetch, template });
const account = (key = 'boat-key-1') => provider().account(key, { requestMs: 2000 });
const sandbox: NewSandbox = {
  machine: 'mch_01jd3m5kq8f4xv9t6w2rhb0c7n',
  name: 'builder',
  vcpu: 4,
  memoryGB: 8,
  idleSeconds: 600,
  labels: { 'acentric.machine': 'mch_01jd3m5kq8f4xv9t6w2rhb0c7n', 'acentric.provider': 'prv_1' },
  provision: '{"server":"https://engine.example","id":"mch_1","token":"t"}',
  key: 'mch_1-0011',
};

beforeEach(() => {
  api = fakeBoat();
});

describe('Boat, as a provider of sandboxes', () => {
  it('has accounts with keys, stops its sandboxes itself, and makes four sizes', () => {
    const one = provider();
    expect(one).toMatchObject({
      kind: 'boat',
      label: 'Boat',
      credential: 'api_key',
      idle: 'provider',
    });
    expect(one.account('k', { requestMs: 1 }).stop).toBeUndefined();
    for (const [vcpu, memoryGB] of [
      [2, 4],
      [4, 8],
      [8, 16],
      [16, 32],
    ] as const) {
      expect(one.sizeProblem(vcpu, memoryGB)).toBeUndefined();
    }
    expect(one.sizeProblem(3, 4)).toBe(
      'Boat has no 3 vCPU / 4 GB size. Its sizes: 2 vCPU / 4 GB, 4 vCPU / 8 GB, 8 vCPU / 16 GB, 16 vCPU / 32 GB',
    );
    expect(one.sizeProblem(2, 8)).toMatch(/^Boat has no 2 vCPU \/ 8 GB size/);
    // Its sandboxes reach the server where people do.
    expect(one.serverFor).toBeUndefined();
  });

  it('makes none on a server that was not told the template', () => {
    expect(provider().unavailable?.()).toBeUndefined();
    for (const without of [boat({ fetch: api.fetch }), provider(''), provider('  ')]) {
      expect(without.unavailable?.()).toBe(
        'Sandboxes at Boat are not set up on this server: it was started without ACENTRIC_BOAT_TEMPLATE',
      );
    }
  });

  it('says whose key it is, and that a key Boat refuses is refused', async () => {
    expect(await account().whoami()).toBe('dev@example.com');
    expect(api.calls[0]?.headers.get('authorization')).toBe('Bearer boat-key-1');
    const refused = await account('bad-key')
      .whoami()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderFailed);
    expect(refused).toMatchObject({
      reason: 'credential',
      status: 401,
      message: "Boat refused the account's API key: add the account again with a new key",
    });
  });

  it('makes a sandbox from the template, with the file its daemon enrols from', async () => {
    const made = await account().create(sandbox);
    expect(made).toEqual({ id: 'sbx_1', state: 'starting', labels: sandbox.labels });
    const [call] = api.callsOf('POST', /^\/sandboxes$/);
    expect(call?.body).toEqual({
      from: 'acentric',
      type: 'default',
      name: 'acentric mch_01jd3m5kq8f4xv9t6w2rhb0c7n',
      ttlSeconds: 600,
      labels: sandbox.labels,
      files: [{ path: BOAT_PROVISION_PATH, content: sandbox.provision }],
    });
    expect(BOAT_PROVISION_PATH).toBe('/home/user/.acentric-provision.json');
    // One key for each try: asked twice with one, Boat makes one sandbox.
    expect(call?.headers.get('idempotency-key')).toBe('mch_1-0011');
  });

  it('says why as Boat did, when Boat does not make it', async () => {
    api.failNext('POST', /^\/sandboxes$/, 402, {
      error: { code: 'payment_required', message: 'The account is out of credit' },
    });
    await expect(account().create(sandbox)).rejects.toThrow(
      'Boat answered 402 payment_required: The account is out of credit',
    );
    api.failNext('POST', /^\/sandboxes$/, 200, {});
    await expect(account().create(sandbox)).rejects.toThrow('Boat answered without a sandbox');
    api.failNext('POST', /^\/sandboxes$/, 429, { code: 'rate_limited', message: 'Slow down' });
    await expect(account().create(sandbox)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Boat answered 429 rate_limited: Slow down',
    });
    api.failNext('POST', /^\/sandboxes$/, 503);
    await expect(account().create(sandbox)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('says how a sandbox stands, in the engine’s words', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    expect(await one.state(id)).toBe('starting');
    api.archive(id);
    expect(await one.state(id)).toBe('stopped');
    expect(await one.state('sbx_9')).toBe('gone');
    const states = {
      init: 'starting',
      provisioning: 'starting',
      provisioned: 'starting',
      cloning: 'starting',
      ready: 'running',
      idle: 'running',
      running: 'running',
      archiving: 'stopping',
      archived: 'stopped',
      error: 'error',
      cancelled: 'gone',
      'something-new': 'unknown',
    };
    for (const [said, means] of Object.entries(states)) expect(boatState(said)).toBe(means);
    expect(boatState(undefined)).toBe('unknown');
  });

  it('sets a sandbox’s timer again, which is its idle time', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    await one.keepFor?.(id, 900);
    expect(api.sandboxes.get(id)?.ttlSeconds).toBe(900);
    expect(api.callsOf('PATCH', /^\/sandboxes\/sbx_1$/)[0]?.body).toEqual({ ttlSeconds: 900 });
    await expect(one.keepFor?.('sbx_9', 900)).rejects.toMatchObject({
      reason: 'gone',
      status: 404,
    });
  });

  it('starts a stopped sandbox again, counts a start under way as done, and says one is busy while it stops', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    api.archive(id);
    expect(await one.start(id, 600)).toBe(true);
    expect(api.callsOf('POST', /\/resume$/)[0]?.body).toEqual({ ttlSeconds: 600 });
    // Starting already, begun by another: this call started nothing.
    expect(await one.start(id, 600)).toBe(false);

    const kept = api.sandboxes.get(id);
    if (kept !== undefined) kept.state = 'archiving';
    const busy = await one.start(id, 600).catch((error: unknown) => error);
    expect(busy).toMatchObject({
      reason: 'busy',
      message: 'Boat answered 409 sandbox_stopping: It is still stopping',
    });
    // A disk Boat no longer keeps cannot be started from, and Boat's reason is passed on.
    api.failNext('POST', /\/resume$/, 409, {
      error: { code: 'snapshot_data_expired', message: 'Its disk was kept for 14 days' },
    });
    await expect(one.start(id, 600)).rejects.toMatchObject({
      reason: 'other',
      message: 'Boat answered 409 snapshot_data_expired: Its disk was kept for 14 days',
    });
  });

  it('deletes a sandbox by confirming its ID, and counts one Boat no longer has as deleted', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    await one.delete(id);
    expect(api.callsOf('DELETE', /./)[0]?.headers.get('x-ascii-confirm-delete')).toBe(id);
    expect(api.sandboxes.size).toBe(0);
    await one.delete(id);
    api.failNext('DELETE', /./, 500);
    await expect(one.delete(id)).rejects.toThrow('Boat answered 500');
  });

  it('lists every sandbox that carries a label, a page at a time', async () => {
    const one = account();
    for (let made = 0; made < 5; made += 1) await one.create({ ...sandbox, key: String(made) });
    await one.create({ ...sandbox, labels: { 'acentric.provider': 'prv_2' } });
    api.pageSize = 2;
    api.calls.length = 0;
    const found = await one.list('acentric.provider', 'prv_1');
    expect([...found.keys()]).toEqual(['sbx_1', 'sbx_2', 'sbx_3', 'sbx_4', 'sbx_5']);
    expect(found.get('sbx_1')).toEqual({ id: 'sbx_1', state: 'starting', labels: sandbox.labels });
    expect(api.calls.map((call) => call.path)).toEqual([
      '/sandboxes?label=acentric.provider%3Dprv_1&limit=200',
      '/sandboxes?label=acentric.provider%3Dprv_1&limit=200&cursor=2',
      '/sandboxes?label=acentric.provider%3Dprv_1&limit=200&cursor=4',
    ]);
  });

  it('says so when Boat cannot be reached', async () => {
    const away = boat({
      template: 'acentric',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(away.account('k', { requestMs: 100 }).whoami()).rejects.toMatchObject({
      name: 'ProviderFailed',
      status: 0,
      message: 'Boat could not be reached',
    });
  });
});
