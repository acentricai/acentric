// Keeping the command the engine's own version of it.
//
// An engine hands out the command of its own build, and says in every answer which one that
// is, by the digest of its file. A command that was installed from an engine compares that
// with its own file. When they differ it offers to take the engine's, once for each version
// the engine has, and only when a person is there to answer. `acentric update` takes it
// without asking.
//
// The engine's version is the one to have, whichever is newer: the command speaks what its
// engine speaks. So what is said is that the versions differ, and never that one is new.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { COMMAND_HEADER } from '@acentric/protocol';

import { configDir } from './credentials.ts';
import type { Env } from './credentials.ts';
import { Fail } from './fail.ts';

/** The version this command was built as. Undefined for one that is not the one file. */
declare const ACENTRIC_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof ACENTRIC_BUILD_VERSION === 'string' ? ACENTRIC_BUILD_VERSION : 'unbuilt';

/** The name of a command's file: the SHA-256 of it, in hex. */
export const digestOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A digest as a person is shown it. */
export const short = (digest: string): string => digest.slice(0, 12);

/**
 * The file of this command, when it is the one file an engine hands out: what
 * `install-cli.sh` put in place, and what an update replaces. Undefined for a command that is
 * run some other way, which is not the engine's to keep.
 */
export function installedFile(argv: readonly string[] = process.argv): string | undefined {
  const [, script] = argv;
  if (script === undefined) return undefined;
  try {
    const file = realpathSync(script);
    return basename(file) === 'acentric.mjs' ? file : undefined;
  } catch {
    return undefined;
  }
}

/** What the engine that was last asked something says it hands out. */
let handedOut: { readonly engine: string; readonly digest: string } | undefined;

export const lastHandedOut = (): typeof handedOut => handedOut;

/** `fetch`, with what each answer of `engine` says it hands out kept. */
export function noting(engine: string, send: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await send(input, init);
    const digest = response.headers.get(COMMAND_HEADER);
    if (digest !== null && /^[0-9a-f]{64}$/.test(digest)) handedOut = { engine, digest };
    return response;
  };
}

// The version a person said no to, so that they are asked once for each.

const declinedFile = (env: Env): string => join(configDir(env), 'update.json');

function declined(env: Env): string | undefined {
  try {
    const value = JSON.parse(readFileSync(declinedFile(env), 'utf8')) as { declined?: unknown };
    return typeof value.declined === 'string' ? value.declined : undefined;
  } catch {
    return undefined;
  }
}

function decline(env: Env, digest: string): void {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(declinedFile(env), `${JSON.stringify({ declined: digest })}\n`, { mode: 0o600 });
}

export type UpdateIo = {
  readonly env: Env;
  readonly out: (line: string) => void;
  /** Asks a person yes or no. Undefined when there is no person to ask. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** In place of the world's `fetch`. */
  readonly fetch?: typeof fetch;
};

/**
 * Replaces the command's file with the one `engine` hands out. With `expected`, what is
 * fetched must be that: what the engine said it hands out. It says what it did.
 */
export async function update(
  io: UpdateIo,
  given: { readonly file: string; readonly engine: string; readonly expected?: string },
): Promise<'updated' | 'same'> {
  const { file, engine } = given;
  const own = digestOf(readFileSync(file));
  let response: Response;
  try {
    response = await (io.fetch ?? fetch)(`${engine}/acentric.mjs`);
  } catch (error) {
    const cause = ((error as Error).cause as Error | undefined)?.message;
    throw new Fail(
      `the engine at ${engine} could not be reached: ${cause ?? (error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Fail(
      `the engine at ${engine} hands out no command (it answered ${String(response.status)})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = digestOf(bytes);
  if (given.expected !== undefined && digest !== given.expected) {
    throw new Fail(
      `what the engine at ${engine} handed out is not what it said it hands out`,
      'nothing was changed: try `acentric update` again',
    );
  }
  if (digest === own) {
    io.out(`This is the version the engine at ${engine} hands out (${short(own)}).`);
    return 'same';
  }
  // Beside where it goes, and moved into place: the command is whole at every moment.
  const next = `${file}.new`;
  writeFileSync(next, bytes, { mode: 0o644 });
  renameSync(next, file);
  io.out(
    `Updated to the version the engine at ${engine} hands out (${short(own)} → ${short(digest)}).`,
  );
  return 'updated';
}

/**
 * After a command: when the engine it asked hands out another version than this one, offers
 * to take it. Nothing is said when no person is there to answer, or when they were asked of
 * this version before and said no.
 */
export async function offerUpdate(io: UpdateIo, file: string | undefined): Promise<void> {
  if (file === undefined || handedOut === undefined || io.confirm === undefined) return;
  const { engine, digest } = handedOut;
  if (digest === digestOf(readFileSync(file)) || declined(io.env) === digest) return;
  const yes = await io.confirm(
    `The engine at ${engine} hands out a different version of this command. Update to it? [Y/n] `,
  );
  if (!yes) {
    decline(io.env, digest);
    io.out('Not updated. `acentric update` does it whenever you want.');
    return;
  }
  await update(io, { file, engine, expected: digest });
  io.out('It is used from the next command on.');
}

/** What `acentric version` says: this command's version, and its engine's. */
export async function version(
  io: UpdateIo,
  given: { readonly file: string | undefined; readonly engine: string | undefined },
): Promise<void> {
  const own = given.file === undefined ? undefined : digestOf(readFileSync(given.file));
  io.out(`acentric ${VERSION}${own === undefined ? '' : ` (${short(own)})`}`);
  const { engine } = given;
  if (engine === undefined) return;
  let response: Response;
  try {
    response = await noting(engine, io.fetch)(`${engine}/health`);
  } catch {
    io.out(`engine ${engine}: could not be reached`);
    return;
  }
  const health = (await response.json().catch(() => ({}))) as { version?: unknown };
  const theirs = response.headers.get(COMMAND_HEADER);
  const said = typeof health.version === 'string' ? health.version : 'an unknown version';
  if (theirs === null) {
    io.out(`engine ${engine}: ${said}. It hands out no command.`);
  } else if (own === undefined) {
    io.out(`engine ${engine}: ${said}. It hands out acentric (${short(theirs)}).`);
  } else if (theirs === own) {
    io.out(`engine ${engine}: ${said}. It hands out this version of acentric.`);
  } else {
    io.out(
      `engine ${engine}: ${said}. It hands out a different version of acentric (${short(theirs)}): \`acentric update\` takes it.`,
    );
  }
}
