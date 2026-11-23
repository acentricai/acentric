// What a server is started with, read from its environment. Whatever is wrong with it is said
// before anything is started: a server does not run with half of what it was told.
//
//   ACENTRIC_PORT           4000 without it. 0 takes any free port
//   ACENTRIC_HOST           127.0.0.1 without it: only this machine
//   ACENTRIC_DATA           the folder its database is in, and the images and files of
//                           conversations. ./data without it
//   ACENTRIC_PUBLIC_URL     where people reach the server, such as https://engine.example.com:
//                           what the links it makes start with. Without it, where it listens
//   ACENTRIC_ADMIN_KEY      an API key that may do everything, of 24 characters or more: what
//                           other keys are made with. Without it, a server that has no key yet
//                           makes one, and prints it once
//   ACENTRIC_SECRET_KEY     the key agents' secrets and the keys of model accounts are sealed
//                           with: 32 bytes, as 64 hex characters or as base64. Without it, the
//                           server keeps neither
//   ACENTRIC_SECRET_KEYS_OLD  keys secrets were sealed with before, separated by commas, so
//                           that what they sealed still opens after the key was changed
//   ACENTRIC_AGENT_NETWORK  what agents' code may reach: `public` (without it), which is
//                           public addresses only, or `any`
//   ACENTRIC_AGENT_NETWORK_ALLOW  with `public`: private addresses and ranges agents' code
//                           may reach as well, separated by commas, such as 10.0.0.0/8
//   ACENTRIC_CODE_PROCESSES how many processes agents' code runs in. 2 without it
//   ACENTRIC_BACKUP_DIR     the folder the server's own backups go in: <ACENTRIC_DATA>/backups
//                           without it, which is on the same disk as what it backs up. Another
//                           disk's is what survives losing that one
//   ACENTRIC_BACKUP_EVERY   how often the server backs itself up, such as 24h (without it), 6h,
//                           30m or 7d; and before a new version changes its database. `off`, for
//                           neither
//   ACENTRIC_BACKUP_KEEP    how many of its backups of each kind it keeps: 3 without it
//   ACENTRIC_DASHBOARD      the folder of the dashboard's build (apps/dashboard/dist), which the
//                           server then serves at every path that is not the API's. Without
//                           it, it serves none, and the links it makes have no page behind them
//   ACENTRIC_DOWNLOADS      a folder with the acentric command (`acentric.mjs`) and the script
//                           that installs it (`install-cli.sh`), which the server then hands
//                           out at `/install-cli.sh`. Without it, it hands out neither
//   ACENTRIC_BOAT_TEMPLATE  the Boat snapshot sandboxes are made from at Boat (boat.dev), which
//                           has the machine program in it (see deploy/sandbox/boat-template.sh).
//                           Without it, an account at Boat can be added, and no sandbox made
//   ACENTRIC_BOAT_API_URL   Boat's API, in place of https://boat.dev/api/v1. For tests
//   ACENTRIC_DOCKER_HOST    where Docker's API is, such as unix:///var/run/docker.sock: with it
//                           the server makes sandboxes there, as containers. Whoever may make a
//                           sandbox then has the computer Docker is on. Without it, it makes
//                           none at Docker
//   ACENTRIC_DOCKER_IMAGE   with it: the image a sandbox is made from, which has the machine
//                           program in it (`docker build --target sandbox` builds one)
//   ACENTRIC_DOCKER_NETWORK the Docker network a sandbox is attached to. Docker's own without it
//   ACENTRIC_DOCKER_SERVER_URL  where a sandbox at Docker reaches this server, when that is
//                           not where people do. Without it, where people do, with
//                           host.docker.internal in place of localhost
//
// What a provider's models are called with is not among them: that is a model account, added
// through the API and kept sealed.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { secretKeyOf } from '@acentric/core';
import type { SecretKeys } from '@acentric/core';
import { checkDockerHost } from '@acentric/sandbox';
import type { BoatOptions, DockerOptions } from '@acentric/sandbox';
import type { Network } from '@acentric/executor';

export type Settings = {
  readonly port: number;
  readonly host: string;
  /** The folder the database is in, and the blobs. */
  readonly data: string;
  /** Where people reach the server: what the links it makes start with. */
  readonly publicUrl: string | undefined;
  readonly adminKey: string | undefined;
  readonly secretKeys: SecretKeys | undefined;
  readonly network: Network;
  readonly codeProcesses: number;
  /** The folder of what the server hands out to be installed elsewhere. */
  readonly downloads: string | undefined;
  /** The folder of the dashboard's build. */
  readonly dashboard: string | undefined;
  /** What sandboxes at Boat are made with: the snapshot they are made from, when one was given. */
  readonly boat: BoatOptions;
  /** The Docker sandboxes are made at, as containers. Undefined when none are. */
  readonly docker: DockerOptions | undefined;
  /** The server's own backups. Undefined when they are off. */
  readonly backups: BackupSettings | undefined;
};

export type BackupSettings = {
  /** The folder they go in. */
  readonly dir: string;
  /** How often one is taken. */
  readonly everyMs: number;
  /** How many of each kind are kept. */
  readonly keep: number;
};

/** A time such as 30m, 24h or 7d, in milliseconds: from ten minutes to a year. */
function durationOf(name: string, value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const ms = match === null ? NaN : Number(match[1]) * unit[match[2] as keyof typeof unit];
  if (!(ms >= 600_000 && ms <= 365 * 86_400_000)) {
    throw new InvalidSettings(
      `${name} is a time such as 30m, 24h or 7d, from 10m to a year, or off, and is ${value}`,
    );
  }
  return ms;
}

/** The settings are wrong. The message says which, and how. */
export class InvalidSettings extends Error {
  override readonly name = 'InvalidSettings';
}

/** A key's ID: the start of its digest, so the same key is the same ID wherever it is given. */
const idOf = (key: Uint8Array): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 12);

export function readSettings(env: { readonly [name: string]: string | undefined }): Settings {
  const given = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const wholeNumber = (name: string, otherwise: number, least: number, most: number): number => {
    const value = given(name);
    if (value === undefined) return otherwise;
    const number = Number(value);
    if (!Number.isInteger(number) || number < least || number > most) {
      // What Kubernetes gives a pod for a Service named acentric in its namespace.
      const service = value.startsWith('tcp://')
        ? ': Kubernetes sets it for a Service named acentric. Set enableServiceLinks: false in the pod'
        : '';
      throw new InvalidSettings(
        `${name} is a whole number from ${String(least)} to ${String(most)}, and is ${value}${service}`,
      );
    }
    return number;
  };
  const list = (name: string): string[] =>
    (given(name) ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');

  const publicUrl = given('ACENTRIC_PUBLIC_URL')?.replace(/\/+$/, '');
  if (publicUrl !== undefined && !/^https?:\/\/[^/]+/.test(publicUrl)) {
    throw new InvalidSettings(
      `ACENTRIC_PUBLIC_URL is where the server is reached, such as https://engine.example.com, and is ${publicUrl}`,
    );
  }

  const adminKey = given('ACENTRIC_ADMIN_KEY');
  if (adminKey !== undefined && adminKey.length < 24) {
    throw new InvalidSettings('ACENTRIC_ADMIN_KEY is 24 characters or more');
  }

  let secretKeys: SecretKeys | undefined;
  const sealing = given('ACENTRIC_SECRET_KEY');
  const before = list('ACENTRIC_SECRET_KEYS_OLD');
  if (sealing === undefined && before.length > 0) {
    throw new InvalidSettings('ACENTRIC_SECRET_KEYS_OLD is given, and ACENTRIC_SECRET_KEY is not');
  }
  if (sealing !== undefined) {
    const keyOf = (name: string, value: string): Uint8Array => {
      try {
        return secretKeyOf(value);
      } catch {
        throw new InvalidSettings(`${name} is 32 bytes, as 64 hex characters or as base64`);
      }
    };
    const current = keyOf('ACENTRIC_SECRET_KEY', sealing);
    const keys: { [id: string]: Uint8Array } = { [idOf(current)]: current };
    for (const old of before) {
      const key = keyOf('Each key of ACENTRIC_SECRET_KEYS_OLD', old);
      keys[idOf(key)] = key;
    }
    secretKeys = { current: idOf(current), keys };
  }

  const reach = given('ACENTRIC_AGENT_NETWORK') ?? 'public';
  if (reach !== 'public' && reach !== 'any') {
    throw new InvalidSettings(`ACENTRIC_AGENT_NETWORK is public or any, and is ${reach}`);
  }
  const allow = list('ACENTRIC_AGENT_NETWORK_ALLOW');
  if (reach === 'any' && allow.length > 0) {
    throw new InvalidSettings(
      'ACENTRIC_AGENT_NETWORK_ALLOW is for ACENTRIC_AGENT_NETWORK=public: with any, everything is reached',
    );
  }

  const downloads = given('ACENTRIC_DOWNLOADS');
  const dashboard = given('ACENTRIC_DASHBOARD');

  const boatTemplate = given('ACENTRIC_BOAT_TEMPLATE');
  const boatUrl = given('ACENTRIC_BOAT_API_URL');
  if (boatUrl !== undefined && !/^https?:\/\/[^/]+/.test(boatUrl)) {
    throw new InvalidSettings(
      `ACENTRIC_BOAT_API_URL is where Boat's API is, such as https://boat.dev/api/v1, and is ${boatUrl}`,
    );
  }

  const dockerHost = given('ACENTRIC_DOCKER_HOST');
  const dockerImage = given('ACENTRIC_DOCKER_IMAGE');
  const dockerNetwork = given('ACENTRIC_DOCKER_NETWORK');
  const dockerServerUrl = given('ACENTRIC_DOCKER_SERVER_URL')?.replace(/\/+$/, '');
  if (dockerHost === undefined) {
    for (const [name, value] of [
      ['ACENTRIC_DOCKER_IMAGE', dockerImage],
      ['ACENTRIC_DOCKER_NETWORK', dockerNetwork],
      ['ACENTRIC_DOCKER_SERVER_URL', dockerServerUrl],
    ] as const) {
      if (value !== undefined) {
        throw new InvalidSettings(`${name} is for a server that has ACENTRIC_DOCKER_HOST`);
      }
    }
  } else {
    try {
      checkDockerHost(dockerHost);
    } catch (error) {
      throw new InvalidSettings(
        `ACENTRIC_DOCKER_HOST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (dockerImage === undefined) {
      throw new InvalidSettings(
        'ACENTRIC_DOCKER_IMAGE is the image sandboxes are made from: a server that has ACENTRIC_DOCKER_HOST has it too',
      );
    }
    if (dockerServerUrl !== undefined && !/^https?:\/\/[^/]+/.test(dockerServerUrl)) {
      throw new InvalidSettings(
        `ACENTRIC_DOCKER_SERVER_URL is where a sandbox reaches the server, such as http://host.docker.internal:4000, and is ${dockerServerUrl}`,
      );
    }
  }

  const data = resolve(given('ACENTRIC_DATA') ?? './data');
  const every = given('ACENTRIC_BACKUP_EVERY') ?? '24h';
  const backups: BackupSettings | undefined =
    every === 'off'
      ? undefined
      : {
          dir: resolve(given('ACENTRIC_BACKUP_DIR') ?? `${data}/backups`),
          everyMs: durationOf('ACENTRIC_BACKUP_EVERY', every),
          keep: wholeNumber('ACENTRIC_BACKUP_KEEP', 3, 1, 1000),
        };

  return {
    port: wholeNumber('ACENTRIC_PORT', 4000, 0, 65_535),
    host: given('ACENTRIC_HOST') ?? '127.0.0.1',
    data,
    publicUrl,
    adminKey,
    secretKeys,
    network: reach === 'any' ? { reach: 'any' } : { reach: 'public', allow },
    codeProcesses: wholeNumber('ACENTRIC_CODE_PROCESSES', 2, 1, 64),
    downloads: downloads === undefined ? undefined : resolve(downloads),
    dashboard: dashboard === undefined ? undefined : resolve(dashboard),
    boat: {
      ...(boatTemplate === undefined ? {} : { template: boatTemplate }),
      ...(boatUrl === undefined ? {} : { url: boatUrl }),
    },
    backups,
    docker:
      dockerHost === undefined || dockerImage === undefined
        ? undefined
        : {
            host: dockerHost,
            image: dockerImage,
            ...(dockerNetwork === undefined ? {} : { network: dockerNetwork }),
            ...(dockerServerUrl === undefined ? {} : { serverUrl: dockerServerUrl }),
          },
  };
}
