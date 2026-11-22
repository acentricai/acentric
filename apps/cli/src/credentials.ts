// Which engine the command calls, and with which key: kept in
// `~/.config/acentric/credentials.json` (or `$XDG_CONFIG_HOME/acentric`, or
// `$ACENTRIC_CONFIG_DIR`), a private file in a private folder, replaced whole on every change.
// ENGINE_URL and ENGINE_API_KEY, when set, are used in its place, as CI does.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Fail } from './fail.ts';

export type Credentials = { readonly engine: string; readonly key: string };

export type Env = { readonly [name: string]: string | undefined };

export function configDir(env: Env): string {
  const own = env['ACENTRIC_CONFIG_DIR'];
  if (own !== undefined && own !== '') return own;
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'acentric');
}

const fileOf = (env: Env): string => join(configDir(env), 'credentials.json');

/** An engine's address as it is kept: its origin, and a path only when it has one. */
export function engineUrl(given: string): string {
  let url: URL;
  try {
    url = new URL(given.includes('://') ? given : `https://${given}`);
  } catch {
    throw new Fail(
      `${given} is not an engine's address`,
      'give one such as https://engine.example.com',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Fail(`${given} is not an engine's address`, 'it starts with https://');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The engine and key to call with: from the environment, else from the file. */
export function readCredentials(env: Env): Credentials | undefined {
  const url = env['ENGINE_URL'];
  const key = env['ENGINE_API_KEY'];
  if (url !== undefined && url !== '' && key !== undefined && key !== '') {
    return { engine: engineUrl(url), key };
  }
  let text: string;
  try {
    text = readFileSync(fileOf(env), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<Credentials>;
    if (typeof value.engine === 'string' && typeof value.key === 'string') {
      // A key in the environment is used with the engine that was signed in to.
      return { engine: value.engine, key: key !== undefined && key !== '' ? key : value.key };
    }
  } catch {
    // Read as a file that cannot be read, below.
  }
  throw new Fail(`${fileOf(env)} cannot be read`, 'remove it and run `acentric login`');
}

export function writeCredentials(env: Env, credentials: Credentials): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = fileOf(env);
  const next = `${file}.${String(process.pid)}`;
  writeFileSync(next, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
  return file;
}

export function removeCredentials(env: Env): boolean {
  try {
    rmSync(fileOf(env));
    return true;
  } catch {
    return false;
  }
}
