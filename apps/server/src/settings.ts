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
//
// What a provider's models are called with is not among them: that is a model account, added
// through the API and kept sealed.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { secretKeyOf } from '@acentric/core';
import type { SecretKeys } from '@acentric/core';
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
};

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
      throw new InvalidSettings(
        `${name} is a whole number from ${String(least)} to ${String(most)}, and is ${value}`,
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

  return {
    port: wholeNumber('ACENTRIC_PORT', 4000, 0, 65_535),
    host: given('ACENTRIC_HOST') ?? '127.0.0.1',
    data: resolve(given('ACENTRIC_DATA') ?? './data'),
    publicUrl,
    adminKey,
    secretKeys,
    network: reach === 'any' ? { reach: 'any' } : { reach: 'public', allow },
    codeProcesses: wholeNumber('ACENTRIC_CODE_PROCESSES', 2, 1, 64),
  };
}
