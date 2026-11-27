// Boat as a provider, against what stands for Boat's API (see `fake-boat.ts`): what it asks
// of Boat, and what it makes of Boat's answers. It has not been run against Boat itself.

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BOAT_BOOT,
  BOAT_PROVISION_PATH,
  BOAT_UNIT,
  ProviderFailed,
  boat,
  boatState,
} from '../src/index.ts';
import type { NewSandbox, TemplateBuild } from '../src/index.ts';
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

describe('a template at Boat', () => {
  const program = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  const builder = () =>
    boat({ fetch: api.fetch, templateTimes: { pollMs: 5, startMs: 2000, saveMs: 2000 } }).account(
      'boat-key-1',
      { requestMs: 2000 },
    );
  const build = (given: Partial<TemplateBuild> = {}): TemplateBuild & { printed: string[] } => {
    const printed: string[] = [];
    return {
      name: 'acentric-tpl-1',
      label: 'with-jq',
      script: 'sudo apt-get install -y jq\n',
      program: (arch) => (arch === 'x64' ? program : undefined),
      labels: { 'acentric.template': 'tpl_1', 'acentric.provider': 'prv_1' },
      key: 'tpl_1-0011',
      scriptSeconds: 60,
      output: (text) => printed.push(text),
      signal: new AbortController().signal,
      printed,
      ...given,
    };
  };

  it('is built in a sandbox of its own: the script, then the machine program, and the disk saved', async () => {
    const asked = build();
    await builder().buildTemplate?.(asked);

    const [made] = api.callsOf('POST', /^\/sandboxes$/);
    expect(made?.body).toMatchObject({
      type: 'small',
      noEnv: true,
      name: 'acentric template with-jq',
      labels: asked.labels,
    });
    expect(made?.headers.get('idempotency-key')).toBe('tpl_1-0011');
    // The builder is gone, and the disk was saved under the build's name.
    expect(api.sandboxes.size).toBe(0);
    expect(api.saved.get('acentric-tpl-1')).toEqual({
      name: 'acentric-tpl-1',
      sandboxId: 'sbx_1',
      status: 'ready',
    });

    const order = api.calls
      .filter((call) => call.method !== 'GET')
      .map((call) => `${call.method} ${call.path.replace(/\/commands\/\d+$/, '/commands/:p')}`);
    expect(order).toEqual([
      'POST /sandboxes',
      'PUT /sandboxes/sbx_1/files',
      'POST /sandboxes/sbx_1/commands',
      'POST /sandboxes/sbx_1/commands',
      'POST /sandboxes/sbx_1/commands',
      'POST /sandboxes/sbx_1/files/upload-url',
      'PUT /sbx_1/tmp/acentric-template/acentric-machine',
      'PUT /sandboxes/sbx_1/files',
      'PUT /sandboxes/sbx_1/files',
      'POST /sandboxes/sbx_1/commands',
      'POST /saved-snapshots',
      'DELETE /sandboxes/sbx_1',
    ]);
    // The script first, as it was given, run from the home folder with what it prints kept.
    const files = api.callsOf('PUT', /\/files$/).map((call) => call.body);
    expect(files[0]).toEqual({
      path: '/tmp/acentric-template/script.sh',
      content: 'sudo apt-get install -y jq\n',
    });
    const [script, tail, uname, install] = api
      .callsOf('POST', /\/commands$/)
      .map((call) => call.body);
    expect(script).toEqual({
      command:
        'cd ~ && exec bash /tmp/acentric-template/script.sh > /tmp/acentric-template/output.log 2>&1 < /dev/null',
      detached: true,
    });
    expect(tail?.['command']).toBe('tail -c 65536 /tmp/acentric-template/output.log');
    expect(uname?.['command']).toBe('uname -m');
    // Then the machine program for its processor, its start-up, and their install.
    expect(
      api.calls
        .find((call) => call.path.endsWith('/acentric-machine'))
        ?.headers.has('authorization'),
    ).toBe(false);
    expect(files[1]).toEqual({ path: '/tmp/acentric-template/boot', content: BOAT_BOOT });
    expect(files[2]).toEqual({
      path: '/tmp/acentric-template/acentric-machine.service',
      content: BOAT_UNIT,
    });
    expect(String(install?.['command'])).toContain(
      'sudo install -D -m 755 /tmp/acentric-template/acentric-machine /usr/local/bin/acentric-machine',
    );
    expect(String(install?.['command'])).toContain(
      'sudo systemctl enable acentric-machine.service',
    );
    expect(String(install?.['command'])).toContain('rm -rf /tmp/acentric-template');
    expect(api.callsOf('POST', /^\/saved-snapshots$/)[0]?.body).toEqual({
      sandboxId: 'sbx_1',
      name: 'acentric-tpl-1',
    });
    // What it printed: the script's, then the install's.
    expect(asked.printed.at(-1)).toBe(
      'the script ran\n\n--- the machine program is installed ---\nacentric-machine 0.0.0\n',
    );
  });

  it('starts what it puts in from the same files as the sandbox image', () => {
    const deploy = new URL('../../../deploy/sandbox/', import.meta.url);
    expect(BOAT_BOOT).toBe(readFileSync(new URL('boot', deploy), 'utf8'));
    expect(BOAT_UNIT).toBe(readFileSync(new URL('acentric-machine.service', deploy), 'utf8'));
  });

  it('fails when its script does, and saves nothing', async () => {
    api.onDetached = () => ({ exitCode: 3, stdout: 'E: Unable to locate package jq\n', looks: 2 });
    const asked = build();
    await expect(builder().buildTemplate?.(asked)).rejects.toMatchObject({
      name: 'TemplateFailed',
      message: 'The script ended with 3',
    });
    expect(asked.printed.at(-1)).toBe('E: Unable to locate package jq\n');
    expect(api.saved.size).toBe(0);
    expect(api.sandboxes.size).toBe(0);
  });

  it('stops a script that runs for too long', async () => {
    api.onDetached = () => ({ exitCode: 0, looks: 1_000_000 });
    await expect(builder().buildTemplate?.(build({ scriptSeconds: 0.05 }))).rejects.toMatchObject({
      message: 'The script ran for more than 0.05 seconds, and was stopped',
    });
    expect(api.callsOf('DELETE', /\/commands\/\d+$/)).toHaveLength(1);
    expect(api.sandboxes.size).toBe(0);
  });

  it('is stopped when it is asked to be', async () => {
    api.onDetached = () => ({ exitCode: 0, looks: 1_000_000 });
    const stop = new AbortController();
    const building = builder().buildTemplate?.(build({ signal: stop.signal }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    await expect(building).rejects.toMatchObject({ message: 'The build was stopped' });
    expect(api.callsOf('DELETE', /\/commands\/\d+$/)).toHaveLength(1);
    expect(api.saved.size).toBe(0);
    expect(api.sandboxes.size).toBe(0);
  });

  it('is stopped while its disk is being saved, and what is saved is left to be deleted', async () => {
    api.saving = { looks: 1_000_000, ends: 'ready' };
    const stop = new AbortController();
    const building = builder().buildTemplate?.(build({ signal: stop.signal }));
    for (let tries = 0; api.saved.size === 0; tries++) {
      if (tries > 500) throw new Error('The disk was never being saved');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    stop.abort();
    await expect(building).rejects.toMatchObject({ message: 'The build was stopped' });
    expect(api.sandboxes.size).toBe(0);
  });

  it('needs a machine program for the processor of its sandbox', async () => {
    api.arch = 'aarch64';
    await expect(builder().buildTemplate?.(build())).rejects.toMatchObject({
      message: "This server hands out no machine program for the sandbox's processor, aarch64",
    });
    expect(api.callsOf('POST', /upload-url$/)).toHaveLength(0);
    expect(api.sandboxes.size).toBe(0);
  });

  it('fails when the machine program cannot be installed, or the disk saved', async () => {
    api.onCommand = (_box, command) =>
      command.includes('--version')
        ? {
            exitCode: 1,
            stderr:
              '~/.acentric is there: a sandbox made from this one would not enrol as itself\n',
          }
        : undefined;
    const asked = build();
    await expect(builder().buildTemplate?.(asked)).rejects.toMatchObject({
      message: 'The machine program could not be installed',
    });
    expect(asked.printed.at(-1)).toContain('~/.acentric is there');

    api.onCommand = () => undefined;
    api.saving = { looks: 2, ends: 'failed' };
    await expect(builder().buildTemplate?.(build({ key: 'again' }))).rejects.toMatchObject({
      message: 'Boat could not save the disk: the disk could not be read',
    });
    expect(api.sandboxes.size).toBe(0);
  });

  it('makes a sandbox from a template in place of the server’s own, and deletes a template', async () => {
    await account().create({ ...sandbox, template: 'acentric-tpl-1' });
    expect(api.sandboxes.get('sbx_1')?.from).toBe('acentric-tpl-1');

    await builder().buildTemplate?.(build({ name: 'acentric-tpl-2' }));
    await builder().deleteTemplate?.('acentric-tpl-2');
    expect(api.saved.size).toBe(0);
    // One it no longer has is deleted already.
    await expect(builder().deleteTemplate?.('acentric-tpl-2')).resolves.toBeUndefined();
  });
});
