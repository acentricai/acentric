// Docker itself, as a provider of sandboxes, against the whole server as it runs: the server
// makes a container from the sandbox image, the machine program in it enrols with what the
// server put there and connects, and commands run in it. Only the model is a stand-in.
//
// It needs a Docker to make containers at, and the sandbox image. The image is the one named
// by ACENTRIC_SANDBOX_IMAGE, or is built here: from the machine program named by
// ACENTRIC_SANDBOX_BINARY, which is one for Linux on the processor Docker runs on, or on Linux
// from the one cargo builds. Where there is no Docker, or nothing to build the image from,
// these tests are passed over, unless ACENTRIC_REQUIRE_DOCKER says they are to run.

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelAnswer, ModelRunner } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import { docker } from '@acentric/sandbox';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { readSettings, start } from '../src/index.ts';
import type { Started } from '../src/index.ts';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODEL_KEY = 'a-key-the-fake-provider-takes';
const HOST = process.env['DOCKER_HOST'] ?? 'unix:///var/run/docker.sock';
const IMAGE = 'acentric-sandbox-test';

/** The sandbox image to make containers from. Undefined when there is none to be had. */
async function sandboxImage(dir: string): Promise<string | undefined> {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 20_000 });
  } catch {
    return undefined;
  }
  const given = process.env['ACENTRIC_SANDBOX_IMAGE'];
  if (given !== undefined && given !== '') return given;
  let binary = process.env['ACENTRIC_SANDBOX_BINARY'];
  if (binary === undefined || binary === '') {
    // The one cargo builds runs in a container only where this is Linux too.
    if (process.platform !== 'linux') return undefined;
    try {
      await run('cargo', ['build', '--package', 'acentric-machine'], { cwd: ROOT });
    } catch {
      return undefined;
    }
    binary = join(ROOT, 'target', 'debug', 'acentric-machine');
  }
  // The machine program is given in place of the stage that builds it for every system.
  const context = join(dir, 'machine-here');
  await mkdir(context);
  await copyFile(binary, join(context, 'machine'));
  await run(
    'docker',
    [
      'build',
      '--quiet',
      '--target',
      'sandbox',
      '--build-context',
      `machine-here=${context}`,
      '--tag',
      IMAGE,
      '.',
    ],
    { cwd: ROOT, timeout: 600_000 },
  );
  return IMAGE;
}

let plan: () => ModelAnswer = () => says('Nothing to do.');
const model: ModelRunner = { run: async () => plan() };

let image: string | undefined;
let dir: string;
let up: Started;
let client: Client;
let agentId: string;
/** The sandboxes that were made, to be deleted when the tests are over. */
const made: string[] = [];

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'acentric-docker-')));
  image = await sandboxImage(dir);
  if (image === undefined) {
    if (process.env['ACENTRIC_REQUIRE_DOCKER'] !== undefined) {
      throw new Error('There is no Docker, or no sandbox image, and these tests are to run');
    }
    return;
  }
  up = await start(
    readSettings({
      ACENTRIC_PORT: '0',
      // A container reaches the server by the computer's own address, not by its loopback.
      ACENTRIC_HOST: '0.0.0.0',
      ACENTRIC_DATA: join(dir, 'data'),
      ACENTRIC_SECRET_KEY: 'ab'.repeat(32),
      ACENTRIC_CODE_PROCESSES: '1',
      ACENTRIC_DOCKER_HOST: HOST,
      ACENTRIC_DOCKER_IMAGE: image,
    }),
    {
      version: 'test',
      providers: new Providers([fakeProvider(model, { keys: [MODEL_KEY] })]),
      log: () => {},
      checkAnswers: true,
    },
  );
  client = createClient({ baseUrl: up.server.url, token: up.firstKey as string });
  await client.call('accounts.create', {
    body: { provider: 'fake', name: 'main', apiKey: MODEL_KEY },
  });
  const deployed = await client.call('deployments.create', {
    body: {
      agent: 'worker',
      manifest: { protocol: 1, sdk: '0.15.0' },
      code: await bundle('worker'),
    },
  });
  agentId = deployed.agent.id;
}, 900_000);

afterAll(async () => {
  if (image === undefined) return;
  for (const machine of made) {
    await client
      .call('sandboxes.delete', { params: { machine: machine as never } })
      .catch(() => {});
  }
  await up.close({ graceMs: 100 });
  await rm(dir, { recursive: true, force: true });
});

describe('a sandbox at Docker', () => {
  it('is a container whose daemon enrols and connects, sleeps when it is stopped, is woken for a command with its disk as it was, and is deleted', async (context) => {
    if (image === undefined) return context.skip();
    const account = await client.call('sandboxProviders.create', {
      body: { kind: 'docker', name: 'this-computer' },
    });
    expect(account.account).toMatch(/^Docker \d+\.\d+.* on ./);

    const sandbox = await client.call('sandboxes.create', {
      body: {
        provider: account.id,
        vcpu: 1,
        memoryGB: 1,
        name: 'builder',
        agents: [agentId as never],
        idleTimeoutSeconds: 600,
      },
    });
    made.push(sandbox.machine.id);
    expect(sandbox).toMatchObject({
      kind: 'docker',
      vcpu: 1,
      memoryGB: 1,
      state: 'running',
      machine: { name: 'builder', enrolled: true, online: true, os: 'linux', home: '/home/user' },
    });
    const params = { machine: sandbox.machine.id };
    const containerId = sandbox.providerSandboxId as string;

    // A command of the machine's own, from outside: it runs as the image's user, in its home.
    const first = await client.call('machineCommands.run', {
      params,
      body: { command: 'echo kept > note.txt; id -un; pwd' },
    });
    expect(first).toMatchObject({ status: 'exited', exit: 0, tail: 'user\n/home/user\n' });
    // Its size is what it may use: one processor's time, and a gigabyte of memory.
    const size = await client.call('machineCommands.run', {
      params,
      body: { command: 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max' },
    });
    expect(size.tail).toBe('100000 100000\n1073741824\n');
    // What it enrolled with is gone from the sandbox: it worked once.
    const left = await client.call('machineCommands.run', {
      params,
      body: { command: 'ls -a ~ | grep -c provision || true' },
    });
    expect(left.tail).toBe('0\n');

    // An actor's model runs commands there with bash, as on any machine.
    const { actor } = await client.call('actors.create', {
      params: { agent: agentId as never },
      body: { machine: { id: sandbox.machine.id, cwd: '~' } },
    });
    const turn = async (command: string): Promise<string> => {
      let asked = false;
      plan = () => {
        if (asked) return says('Done.');
        asked = true;
        return calls({ id: `c${String(Date.now())}`, name: 'bash', arguments: { command } });
      };
      const before = (await client.call('actors.get', { params: { actor: actor.id } })).lastTurn
        ?.at;
      await client.call('inputs.send', {
        params: { actor: actor.id },
        body: { type: 'message', payload: { text: 'Work.' } },
      });
      await expect
        .poll(
          async () => {
            const now = await client.call('actors.get', { params: { actor: actor.id } });
            return now.status === 'idle' && now.lastTurn?.at !== before;
          },
          { timeout: 60_000, interval: 50 },
        )
        .toBe(true);
      const { items } = await client.call('messages.list', {
        params: { actor: actor.id },
        query: { limit: 200 },
      });
      const result = items.filter((entry) => entry.message.role === 'tool_result').at(-1);
      return JSON.stringify(result?.message);
    };
    expect(await turn('cat note.txt')).toContain('kept');

    // It sleeps: stopped as the engine stops one that was idle for its time. Its disk is kept.
    const itself = docker({ host: HOST, image }).account(null, { requestMs: 30_000 });
    expect(await itself.state(containerId)).toBe('running');
    await itself.stop?.(containerId);
    expect(await itself.state(containerId)).toBe('stopped');
    await expect
      .poll(async () => (await client.call('machines.get', { params })).online, {
        timeout: 20_000,
        interval: 50,
      })
      .toBe(false);
    const listed = await client.call('sandboxProviders.sandboxes', {
      params: { provider: account.id },
    });
    expect(listed.items.map((one) => [one.machine.name, one.state])).toEqual([
      ['builder', 'stopped'],
    ]);

    // And is woken for the next command, which finds what was written before.
    expect(await turn('cat note.txt; echo again >> note.txt')).toContain('kept');
    expect(await itself.state(containerId)).toBe('running');
    const again = await client.call('machineCommands.run', {
      params,
      body: { command: 'cat note.txt' },
    });
    expect(again.tail).toBe('kept\nagain\n');

    // Deleted, it is gone from Docker, and so is its machine.
    await client.call('sandboxes.delete', { params });
    expect(await itself.state(containerId)).toBe('gone');
    expect((await itself.list('acentric.provider', account.id)).size).toBe(0);
    expect((await client.call('machines.list')).items).toEqual([]);
    await client.call('sandboxProviders.delete', { params: { provider: account.id } });
  }, 240_000);

  it('is refused with what Docker says, when Docker has no such image: nothing is left behind', async (context) => {
    if (image === undefined) return context.skip();
    const nowhere = docker({ host: HOST, image: 'acentric-no-such-image:none' });
    const account = nowhere.account(null, { requestMs: 30_000 });
    const failed = await account
      .create({
        machine: 'mch_test',
        name: 'none',
        vcpu: 1,
        memoryGB: 1,
        idleSeconds: 600,
        labels: { 'acentric.machine': 'mch_test' },
        provision: '{}',
        key: 'k',
      })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({
      name: 'ProviderFailed',
      message: expect.stringMatching(/^Docker answered 404: .*acentric-no-such-image/) as string,
    });
    expect((await account.list('acentric.machine', 'mch_test')).size).toBe(0);
  }, 60_000);
});
