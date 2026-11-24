// The updater beside the server, as the server speaks with it: through a folder they share
// (ACENTRIC_UPDATER_DIR), in two files of `name=value` lines. The server writes `request`:
// which version, to download or to take, and when. The updater writes `status`: what it is doing
// about it. The updater is what may restart the server, so the server asks only for the version
// the update check says is next, and the updater checks what it is asked again on its side.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Updater, UpdaterState, UpdateRequest } from '@acentric/protocol';

const STATES: readonly UpdaterState[] = [
  'idle',
  'downloading',
  'downloaded',
  'waiting',
  'updating',
  'done',
  'failed',
  'cancelled',
];

/** A file of `name=value` lines, as an object: lines of another shape are passed over. */
export function linesOf(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** A time the updater wrote, in seconds since 1970, as milliseconds. Null for none. */
const timeOf = (value: string | undefined): number | null => {
  const seconds = Number(value);
  return value === undefined || value === '' || !Number.isFinite(seconds) || seconds <= 0
    ? null
    : seconds * 1000;
};

/** How long after the updater last said it is there it is taken as gone: it says so every few seconds. */
const ALIVE_MS = 60_000;

export class UpdaterFolder {
  readonly #dir: string;
  readonly #clock: () => number;

  constructor(dir: string, clock: () => number = Date.now) {
    this.#dir = dir;
    this.#clock = clock;
  }

  /** Whether the updater is running: it says so every few seconds, in `alive`. */
  async alive(): Promise<boolean> {
    const said = timeOf((await readFile(join(this.#dir, 'alive'), 'utf8').catch(() => '')).trim());
    return said !== null && this.#clock() - said < ALIVE_MS;
  }

  /**
   * What the updater says it is doing: idle, before it has said anything; null while it is not
   * running, so that nothing is asked of it then.
   */
  async status(): Promise<Updater | null> {
    if (!(await this.alive())) return null;
    const text = await readFile(join(this.#dir, 'status'), 'utf8').catch(() => '');
    const said = linesOf(text);
    const state = STATES.find((each) => each === said['state']) ?? 'idle';
    return {
      state,
      version: said['version'] === undefined || said['version'] === '' ? null : said['version'],
      at: timeOf(said['at']),
      error: said['error'] === undefined || said['error'] === '' ? null : said['error'],
      changedAt: timeOf(said['changed']),
    };
  }

  /** Whether the updater is taking a version now: what is asked then is not changed. */
  async busy(): Promise<boolean> {
    return (await this.status())?.state === 'updating';
  }

  /** Asks it for `asked`, in place of what it was asked before. */
  async request(asked: UpdateRequest): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const at = asked.action === 'install' && asked.at != null ? Math.floor(asked.at / 1000) : 0;
    const lines = [
      `id=${randomBytes(8).toString('hex')}`,
      `action=${asked.action}`,
      `version=${asked.version}`,
      `at=${String(at)}`,
      '',
    ];
    // Whole or not at all: the updater never reads half of it.
    const part = join(this.#dir, `.request-${randomBytes(4).toString('hex')}`);
    await writeFile(part, lines.join('\n'), { mode: 0o644 });
    await rename(part, join(this.#dir, 'request'));
  }

  /** Takes back what it was asked. */
  async cancel(): Promise<void> {
    await rm(join(this.#dir, 'request'), { force: true });
  }
}
