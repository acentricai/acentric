// Docker as a provider, against what stands for Docker's API: a server on a socket that keeps
// what it was asked, and answers as Docker does. Docker itself is run against the whole server
// where the server is tested.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderFailed, docker, dockerState } from '../src/index.ts';
import type { NewSandbox } from '../src/index.ts';
import { tarOf } from '../src/tar.ts';

type Asked = { method: string; path: string; type: string | undefined; body: Buffer };
type Container = { Id: string; State: string; Labels: { [name: string]: string } };

let dir: string;
let server: Server;
let host: string;
let asked: Asked[];
let containers: Map<string, Container>;
/** Answers a request in Docker's place, when it gives what with. */
let instead: (one: Asked) => { status: number; message?: string } | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acentric-fake-docker-'));
  asked = [];
  containers = new Map();
  instead = () => undefined;
  server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://docker');
      const one: Asked = {
        method: request.method ?? '',
        path: url.pathname + url.search,
        type: request.headers['content-type'],
        body: Buffer.concat(parts),
      };
      asked.push(one);
      const answer = (status: number, data?: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(data === undefined ? '' : JSON.stringify(data));
      };
      const forced = instead(one);
      if (forced !== undefined) return answer(forced.status, { message: forced.message });
      const [, , id, action] = url.pathname.split('/');
      const container = containers.get(id ?? '');
      const route = `${one.method} ${url.pathname.replace(/\/c\d+/, '/{id}')}`;
      if (route === 'GET /info') return answer(200, { Name: 'box', ServerVersion: '29.2.1' });
      if (route === 'POST /containers/create') {
        const made = `c${String(containers.size + 1)}`;
        const { Labels } = JSON.parse(one.body.toString()) as Container;
        containers.set(made, { Id: made, State: 'created', Labels });
        return answer(201, { Id: made });
      }
      if (route === 'GET /containers/json') {
        const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] };
        const [name, value] = (filters.label?.[0] ?? '=').split('=');
        return answer(
          200,
          [...containers.values()].filter((each) => each.Labels[name ?? ''] === value),
        );
      }
      if (container === undefined)
        return answer(404, { message: `No such container: ${String(id)}` });
      if (route === 'GET /containers/{id}/json') {
        return answer(200, { Id: container.Id, State: { Status: container.State } });
      }
      if (route === 'PUT /containers/{id}/archive') return answer(200);
      if (one.method === 'POST' && action === 'start') {
        if (container.State === 'running') return answer(304);
        container.State = 'running';
        return answer(204);
      }
      if (one.method === 'POST' && action === 'stop') {
        if (container.State !== 'running') return answer(304);
        container.State = 'exited';
        return answer(204);
      }
      if (one.method === 'DELETE') {
        containers.delete(container.Id);
        return answer(204);
      }
      return answer(500, { message: `not expected: ${route}` });
    });
  });
  const socket = join(dir, 'docker.sock');
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  host = `unix://${socket}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const provider = (more: { network?: string; serverUrl?: string } = {}) =>
  docker({ host, image: 'acentric-sandbox:1', ...more });
const account = (more?: Parameters<typeof provider>[0]) =>
  provider(more).account(null, { requestMs: 2000 });
const sandbox: NewSandbox = {
  machine: 'mch_01jd3m5kq8f4xv9t6w2rhb0c7n',
  name: 'builder',
  vcpu: 2,
  memoryGB: 4,
  idleSeconds: 600,
  labels: { 'acentric.machine': 'mch_01jd3m5kq8f4xv9t6w2rhb0c7n', 'acentric.provider': 'prv_1' },
  provision: '{"server":"http://host.docker.internal:4000","id":"mch_1","token":"t"}',
  key: 'k',
};

describe('Docker, as a provider of sandboxes', () => {
  it('has no key, leaves stopping to the engine, and makes any whole size', () => {
    const one = provider();
    expect(one).toMatchObject({
      kind: 'docker',
      label: 'Docker',
      credential: 'none',
      idle: 'engine',
    });
    expect(one.account(null, { requestMs: 1 }).keepFor).toBeUndefined();
    expect(one.sizeProblem(1, 1)).toBeUndefined();
    expect(one.sizeProblem(64, 512)).toBeUndefined();
    for (const [vcpu, memoryGB] of [
      [0, 1],
      [1.5, 2],
      [65, 2],
      [2, 513],
    ] as const) {
      expect(one.sizeProblem(vcpu, memoryGB)).toBe(
        'A sandbox at Docker has 1 to 64 vCPU and 1 to 512 GB of memory, in whole numbers',
      );
    }
  });

  it('says where a sandbox reaches a server that is on the computer Docker is on', () => {
    const one = provider();
    expect(one.serverFor?.('http://localhost:4000')).toBe('http://host.docker.internal:4000');
    expect(one.serverFor?.('http://127.0.0.1:4000')).toBe('http://host.docker.internal:4000');
    expect(one.serverFor?.('http://0.0.0.0:4000')).toBe('http://host.docker.internal:4000');
    expect(one.serverFor?.('https://engine.example.com')).toBe('https://engine.example.com');
    // Or where the server was told its sandboxes reach it.
    expect(provider({ serverUrl: 'http://server:4000' }).serverFor?.('http://localhost:4000')).toBe(
      'http://server:4000',
    );
  });

  it('is reached at a socket or an address, and nothing else', () => {
    expect(() => docker({ host: 'tcp://10.0.0.5:2375', image: 'i' })).not.toThrow();
    expect(() => docker({ host: 'http://10.0.0.5:2375', image: 'i' })).not.toThrow();
    expect(() => docker({ host: 'ssh://box', image: 'i' })).toThrow(
      'Docker is reached at unix://<socket> or http://<host>:<port>, not ssh://box',
    );
  });

  it('says whose it is: the Docker it reached', async () => {
    expect(await account().whoami()).toBe('Docker 29.2.1 on box');
  });

  it('makes a container of the size asked, puts what the daemon enrols with in it, and starts it', async () => {
    const made = await account({ network: 'acentric' }).create(sandbox);
    expect(made).toEqual({ id: 'c1', state: 'running', labels: sandbox.labels });
    expect(asked.map((one) => `${one.method} ${one.path}`)).toEqual([
      'POST /containers/create?name=acentric-mch_01jd3m5kq8f4xv9t6w2rhb0c7n',
      'PUT /containers/c1/archive?path=%2Fhome%2Fuser',
      'POST /containers/c1/start',
    ]);
    expect(JSON.parse(asked[0]?.body.toString() ?? '')).toEqual({
      Image: 'acentric-sandbox:1',
      Labels: sandbox.labels,
      HostConfig: {
        NanoCpus: 2_000_000_000,
        Memory: 4 * 2 ** 30,
        Init: true,
        ExtraHosts: ['host.docker.internal:host-gateway'],
        NetworkMode: 'acentric',
      },
    });

    // The file is an archive of one: the image's user's, for it alone, in its home.
    const archive = asked[1];
    expect(archive?.type).toBe('application/x-tar');
    const tar = archive?.body ?? Buffer.alloc(0);
    const field = (from: number, length: number) =>
      tar
        .subarray(from, from + length)
        .toString('ascii')
        .replace(/\0.*$/s, '');
    expect(field(0, 100)).toBe('.acentric-provision.json');
    expect(parseInt(field(100, 8), 8)).toBe(0o600);
    expect(parseInt(field(108, 8), 8)).toBe(1000);
    expect(parseInt(field(116, 8), 8)).toBe(1000);
    const size = parseInt(field(124, 12), 8);
    expect(tar.subarray(512, 512 + size).toString()).toBe(sandbox.provision);
    expect(tar.length % 512).toBe(0);

    // Without a network said, Docker's own.
    await account().create(sandbox);
    expect(JSON.parse(asked[3]?.body.toString() ?? '')).not.toHaveProperty(
      'HostConfig.NetworkMode',
    );
  });

  it('leaves nothing behind of a container that could not be started, and says why as Docker did', async () => {
    instead = (one) =>
      one.path.endsWith('/start') ? { status: 500, message: 'no room on the device' } : undefined;
    const failed = await account()
      .create(sandbox)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ProviderFailed);
    expect(failed).toMatchObject({
      code: 'sandbox_provider_failed',
      status: 500,
      message: 'Docker answered 500: no room on the device',
    });
    expect(asked.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/containers/c1?force=true&v=true',
    });
    expect(containers.size).toBe(0);

    instead = (one) =>
      one.path.startsWith('/containers/create')
        ? { status: 404, message: 'No such image: acentric-sandbox:1' }
        : undefined;
    await expect(account().create(sandbox)).rejects.toThrow(
      'Docker answered 404: No such image: acentric-sandbox:1',
    );
  });

  it('says how a container stands, in the engine’s words', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    expect(await one.state(id)).toBe('running');
    expect(await one.state('c9')).toBe('gone');
    expect(
      ['created', 'running', 'restarting', 'removing', 'exited', 'paused', 'dead', 'new'].map(
        dockerState,
      ),
    ).toEqual([
      'stopped',
      'running',
      'starting',
      'stopping',
      'stopped',
      'stopped',
      'error',
      'unknown',
    ]);
    expect(dockerState(undefined)).toBe('unknown');
  });

  it('stops a container and starts it again, and takes one that is so already as done', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    asked.length = 0;
    await one.stop?.(id);
    expect(containers.get(id)?.State).toBe('exited');
    await one.stop?.(id);
    expect(await one.state(id)).toBe('stopped');
    expect(await one.start(id, 600)).toBe(true);
    // Running already, started by another: this call started nothing.
    expect(await one.start(id, 600)).toBe(false);
    expect(asked.filter((each) => each.method === 'POST').map((each) => each.path)).toEqual([
      '/containers/c1/stop?t=10',
      '/containers/c1/stop?t=10',
      '/containers/c1/start',
      '/containers/c1/start',
    ]);
    // One Docker no longer has cannot be stopped or started, and is said to be gone.
    await expect(one.stop?.('c9')).rejects.toMatchObject({ reason: 'gone', status: 404 });
    await expect(one.start('c9', 600)).rejects.toMatchObject({ reason: 'gone' });
  });

  it('deletes a container with what it kept, running or not, and one that is gone already', async () => {
    const one = account();
    const { id } = await one.create(sandbox);
    await one.delete(id);
    expect(asked.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/containers/c1?force=true&v=true',
    });
    expect(containers.size).toBe(0);
    await one.delete(id);
  });

  it('lists the containers that carry a label, whatever their state', async () => {
    const one = account();
    await one.create(sandbox);
    await one.create({ ...sandbox, labels: { ...sandbox.labels, 'acentric.provider': 'prv_2' } });
    await one.stop?.('c1');
    asked.length = 0;
    const found = await one.list('acentric.provider', 'prv_1');
    expect([...found.values()]).toEqual([{ id: 'c1', state: 'stopped', labels: sandbox.labels }]);
    const query = new URL(asked[0]?.path ?? '', 'http://docker').searchParams;
    expect(query.get('all')).toBe('true');
    expect(JSON.parse(query.get('filters') ?? '')).toEqual({ label: ['acentric.provider=prv_1'] });
    expect((await one.list('acentric.machine', 'mch_other')).size).toBe(0);
  });

  it('says so when Docker cannot be reached, or does not answer in time', async () => {
    const away = docker({ host: `unix://${join(dir, 'none.sock')}`, image: 'i' });
    const failed = await away
      .account(null, { requestMs: 500 })
      .whoami()
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ProviderFailed);
    expect(failed).toMatchObject({
      status: 0,
      message: `Docker could not be reached at unix://${join(dir, 'none.sock')}`,
    });

    server.removeAllListeners('request');
    server.on('request', () => {
      // Never answered.
    });
    await expect(provider().account(null, { requestMs: 50 }).whoami()).rejects.toThrow(
      'Docker could not be reached',
    );
    server.closeAllConnections();
  });
});

describe('an archive of one file', () => {
  it('has a header that adds up, the file, and its end', () => {
    const tar = tarOf({
      name: 'a.txt',
      content: 'héllo',
      uid: 1000,
      gid: 1000,
      mtime: 1_795_305_600,
    });
    expect(tar.length).toBe(512 + 512 + 1024);
    const header = Buffer.from(tar.subarray(0, 512));
    const said = parseInt(header.subarray(148, 154).toString('ascii'), 8);
    header.fill(' ', 148, 156);
    expect(said).toBe(header.reduce((sum, byte) => sum + byte, 0));
    expect(tar.subarray(257, 263).toString('ascii')).toBe('ustar\0');
    expect(tar.subarray(512, 518).toString()).toBe('héllo');
    expect(tar.subarray(1024).every((byte) => byte === 0)).toBe(true);
    expect(() => tarOf({ name: 'a'.repeat(101), content: '', uid: 0, gid: 0, mtime: 0 })).toThrow(
      RangeError,
    );
  });
});
