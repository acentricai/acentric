// Docker, as a provider of sandboxes: a sandbox is a container, on a Docker the server
// reaches by its socket or by an address. It is made from an image that has the daemon in it
// (see `apps/machine/sandbox`). What its daemon enrols with is put in it as a file before it
// starts.
//
// Docker stops nothing by itself: the engine stops a container that was idle for its time,
// and starts it again for what needs it. A stopped container keeps its disk.
//
// Whoever can ask Docker to make a container has the computer Docker is on: a server is set
// up with this only where that is meant.

import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';

import { ProviderFailed, providerFailure } from '@acentric/core';
import type { NewSandbox, ProviderSandbox, SandboxAccount, SandboxProvider } from '@acentric/core';
import type { SandboxState } from '@acentric/protocol';

import { tarOf } from './tar.ts';

/** Where the image's start-up looks for what its daemon enrols with, and whose it is there. */
export const SANDBOX_HOME = '/home/user';
export const PROVISION_FILE = '.acentric-provision.json';
export const SANDBOX_UID = 1000;

/** The sizes a container is made in. */
const MAX_VCPU = 64;
const MAX_MEMORY_GB = 512;

/** How long a container's processes have to end when it is stopped, in seconds. */
const STOP_GRACE_S = 10;

export type DockerOptions = {
  /** Where Docker's API is: `unix:///var/run/docker.sock`, or `http://host:2375`. */
  readonly host: string;
  /** The image sandboxes are made from, which has the daemon in it. */
  readonly image: string;
  /** The network a sandbox is attached to. Docker's own default without it. */
  readonly network?: string;
  /** Where a sandbox reaches the server, when that is not where people do. */
  readonly serverUrl?: string;
};

/** Docker's states of a container, in the engine's words. */
export function dockerState(status: string | undefined): SandboxState {
  switch (status) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'removing':
      return 'stopping';
    // One that was made and never started is started as a stopped one is.
    case 'created':
    case 'exited':
    case 'paused':
      return 'stopped';
    case 'dead':
      return 'error';
    default:
      return 'unknown';
  }
}

type Answer = { readonly status: number; readonly data: unknown };

/** Where a request to Docker goes: its socket, or its address. */
function target(host: string): RequestOptions {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const url = new URL(host.replace(/^tcp:\/\//, 'http://'));
  if (url.protocol !== 'http:') {
    throw new Error(`Docker is reached at unix://<socket> or http://<host>:<port>, not ${host}`);
  }
  return { host: url.hostname, port: url.port === '' ? 2375 : Number(url.port) };
}

/** Checks where Docker is said to be. Throws with what is wrong with it. */
export function checkDockerHost(host: string): void {
  target(host);
}

/** One request to Docker's API. Rejects when Docker cannot be reached, or answers no. */
function ask(
  options: DockerOptions,
  requestMs: number,
  method: string,
  path: string,
  body?: { readonly json: unknown } | { readonly tar: Buffer },
  /** The statuses that are answers, beside those that say it went well. */
  taken: readonly number[] = [],
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent =
      body === undefined
        ? undefined
        : 'tar' in body
          ? body.tar
          : Buffer.from(JSON.stringify(body.json));
    const unreachable = (): void => {
      reject(new ProviderFailed(`Docker could not be reached at ${options.host}`));
    };
    const call = httpRequest(
      {
        ...target(options.host),
        method,
        path,
        headers: {
          host: 'docker',
          accept: 'application/json',
          ...(sent === undefined
            ? {}
            : {
                'content-type':
                  body !== undefined && 'tar' in body ? 'application/x-tar' : 'application/json',
                'content-length': sent.length,
              }),
        },
        signal: AbortSignal.timeout(requestMs),
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('error', unreachable);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          let data: unknown = null;
          try {
            data = JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            // The status is enough.
          }
          if ((status >= 200 && status < 300) || taken.includes(status)) {
            resolve({ status, data });
            return;
          }
          const said = (data as { message?: unknown } | null)?.message;
          reject(providerFailure('Docker', status, typeof said === 'string' ? said : undefined));
        });
      },
    );
    call.on('error', unreachable);
    call.end(sent);
  });
}

/** Docker's name for a machine's container. A machine's ID is letters, digits and `_`. */
const nameOf = (machine: string): string => `acentric-${machine}`;

/** A Docker's containers, as sandboxes. It has no accounts of its own, and no key. */
function accountOf(options: DockerOptions, requestMs: number): SandboxAccount {
  const call = (
    method: string,
    path: string,
    body?: Parameters<typeof ask>[4],
    taken?: readonly number[],
  ): Promise<Answer> => ask(options, requestMs, method, path, body, taken);
  const container = (id: string): string => `/containers/${encodeURIComponent(id)}`;

  return {
    async whoami(): Promise<string | null> {
      const { data } = await call('GET', '/info');
      const { Name, ServerVersion } = (data ?? {}) as { Name?: unknown; ServerVersion?: unknown };
      const version = typeof ServerVersion === 'string' ? ` ${ServerVersion}` : '';
      return typeof Name === 'string' ? `Docker${version} on ${Name}`.slice(0, 254) : null;
    },

    async create(sandbox: NewSandbox): Promise<ProviderSandbox> {
      const made = await call(
        'POST',
        `/containers/create?name=${encodeURIComponent(nameOf(sandbox.machine))}`,
        {
          json: {
            Image: options.image,
            Labels: sandbox.labels,
            HostConfig: {
              NanoCpus: sandbox.vcpu * 1_000_000_000,
              Memory: sandbox.memoryGB * 2 ** 30,
              // A process that reaps what its commands leave behind, and passes signals on.
              Init: true,
              // Where a server on the computer Docker is on is reached, on every system.
              ExtraHosts: ['host.docker.internal:host-gateway'],
              ...(options.network === undefined ? {} : { NetworkMode: options.network }),
            },
          },
        },
      );
      const id = (made.data as { Id?: unknown } | null)?.Id;
      if (typeof id !== 'string') throw new ProviderFailed('Docker answered without a container');
      try {
        await call('PUT', `${container(id)}/archive?path=${encodeURIComponent(SANDBOX_HOME)}`, {
          tar: tarOf({
            name: PROVISION_FILE,
            content: sandbox.provision,
            uid: SANDBOX_UID,
            gid: SANDBOX_UID,
            mtime: Math.floor(Date.now() / 1000),
          }),
        });
        await call('POST', `${container(id)}/start`);
      } catch (error) {
        // Nothing of one that never started is left behind.
        await call('DELETE', `${container(id)}?force=true&v=true`).catch(() => {});
        throw error;
      }
      return { id, state: 'running', labels: sandbox.labels };
    },

    async state(id: string): Promise<SandboxState> {
      const { status, data } = await call('GET', `${container(id)}/json`, undefined, [404]);
      if (status === 404) return 'gone';
      return dockerState((data as { State?: { Status?: string } } | null)?.State?.Status);
    },

    async start(id: string): Promise<boolean> {
      // 304: it is running already, started by another.
      return (await call('POST', `${container(id)}/start`, undefined, [304])).status !== 304;
    },

    async stop(id: string): Promise<void> {
      // 304: it is stopped already.
      await call('POST', `${container(id)}/stop?t=${String(STOP_GRACE_S)}`, undefined, [304]);
    },

    async delete(id: string): Promise<void> {
      // Its volumes with it, running or not. 404: it is deleted already.
      await call('DELETE', `${container(id)}?force=true&v=true`, undefined, [404]);
    },

    async list(label: string, value: string): Promise<Map<string, ProviderSandbox>> {
      const filters = JSON.stringify({ label: [`${label}=${value}`] });
      const { data } = await call(
        'GET',
        `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
      );
      const found = new Map<string, ProviderSandbox>();
      for (const one of Array.isArray(data) ? data : []) {
        const { Id, State, Labels } = one as {
          Id?: unknown;
          State?: unknown;
          Labels?: { readonly [name: string]: string };
        };
        if (typeof Id !== 'string') continue;
        found.set(Id, {
          id: Id,
          state: dockerState(typeof State === 'string' ? State : undefined),
          ...(Labels === undefined || Labels === null ? {} : { labels: Labels }),
        });
      }
      return found;
    },
  };
}

/** A server on the computer Docker is on is not at `localhost` for a container. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** Docker, as a provider of sandboxes. */
export function docker(options: DockerOptions): SandboxProvider {
  checkDockerHost(options.host);
  return {
    kind: 'docker',
    label: 'Docker',
    credential: 'none',
    idle: 'engine',
    sizeProblem(vcpu: number, memoryGB: number): string | undefined {
      const whole = (value: number, most: number): boolean =>
        Number.isInteger(value) && value >= 1 && value <= most;
      return whole(vcpu, MAX_VCPU) && whole(memoryGB, MAX_MEMORY_GB)
        ? undefined
        : `A sandbox at Docker has 1 to ${String(MAX_VCPU)} vCPU and 1 to ${String(MAX_MEMORY_GB)} GB of memory, in whole numbers`;
    },
    serverFor(url: string): string {
      if (options.serverUrl !== undefined) return options.serverUrl;
      const server = new URL(url);
      if (!LOOPBACK.has(server.hostname)) return url;
      server.hostname = 'host.docker.internal';
      return server.toString().replace(/\/$/, '');
    },
    account: (_credential, { requestMs }) => accountOf(options, requestMs),
  };
}
