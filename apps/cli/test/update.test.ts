import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_HEADER } from '@acentric/protocol';

import { withEngine } from '../src/engine.ts';
import { Fail } from '../src/fail.ts';
import {
  digestOf,
  installedFile,
  lastHandedOut,
  noting,
  offerUpdate,
  short,
  update,
  version,
} from '../src/update.ts';

// As it really is: on macOS the folder for temporary files is reached through a link.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acentric-update-')));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENGINE = 'https://engine.example.com';
const text = (value: string) => new TextEncoder().encode(value);
const MINE = text('// the command, as it is installed\n');
const THEIRS = text('// the command, as the engine hands it out\n');

/** An engine that hands out `command`, and says so in every answer. None, for one that has none. */
function engine(command: Uint8Array | undefined, said = command): typeof fetch {
  return async (input) => {
    const headers = said === undefined ? {} : { [COMMAND_HEADER]: digestOf(said) };
    if (String(input).endsWith('/acentric.mjs')) {
      return command === undefined
        ? new Response('not found', { status: 404 })
        : new Response(command, { headers });
    }
    return Response.json({ ok: true, version: '0.15.0' }, { headers });
  };
}

let made = 0;
/** A command installed in a folder of its own, a person's own folder, and what was said. */
function installed(confirm?: boolean | 'never asked') {
  made += 1;
  const home = join(dir, String(made));
  mkdirSync(join(home, 'bin'), { recursive: true });
  const file = join(home, 'bin', 'acentric.mjs');
  writeFileSync(file, MINE);
  const out: string[] = [];
  const asked: string[] = [];
  const io = (send: typeof fetch) => ({
    env: { HOME: home },
    out: (line: string) => out.push(line),
    fetch: send,
    ...(confirm === undefined
      ? {}
      : {
          confirm: async (question: string) => {
            asked.push(question);
            return confirm === true;
          },
        }),
  });
  return { file, out, asked, io, read: () => new Uint8Array(readFileSync(file)) };
}

/** Has an engine answer something, as any command of this one does. */
const ask = (send: typeof fetch) => noting(ENGINE, send)(`${ENGINE}/v1/me`);

describe('the command’s own file', () => {
  it('is the one file an engine hands out, and nothing else that it is run as', () => {
    const { file } = installed();
    expect(installedFile(['node', file])).toBe(file);
    const other = join(dir, 'bin.js');
    writeFileSync(other, '');
    expect(installedFile(['node', other])).toBeUndefined();
    expect(installedFile(['node', join(dir, 'gone', 'acentric.mjs')])).toBeUndefined();
    expect(installedFile(['node'])).toBeUndefined();
  });
});

describe('what an engine hands out', () => {
  it('is noted from each of its answers, when it says', async () => {
    await ask(engine(THEIRS));
    expect(lastHandedOut()).toEqual({ engine: ENGINE, digest: digestOf(THEIRS) });
    // An answer that says nothing, or what is no digest, changes nothing.
    await ask(engine(undefined));
    await noting(ENGINE, async () => new Response('', { headers: { [COMMAND_HEADER]: 'x' } }))('/');
    expect(lastHandedOut()).toEqual({ engine: ENGINE, digest: digestOf(THEIRS) });
  });
});

describe('a command that asks its engine something', () => {
  it('notes what the engine hands out from the answer, with nothing more asked', async () => {
    const asked: string[] = [];
    const answering = engine(THEIRS);
    vi.stubGlobal('fetch', (async (input, init) => {
      asked.push(String(input));
      return answering(input, init);
    }) satisfies typeof fetch);
    try {
      const other = 'https://another.example.com';
      await withEngine({ engine: other, key: 'ak_one' }, (client) => client.call('me.get'));
      expect(lastHandedOut()).toEqual({ engine: other, digest: digestOf(THEIRS) });
      expect(asked).toEqual([`${other}/v1/me`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('after a command, the engine’s version', () => {
  beforeEach(async () => {
    await ask(engine(THEIRS));
  });

  it('is taken when a person says yes: the file is the engine’s from then on', async () => {
    const one = installed(true);
    await offerUpdate(one.io(engine(THEIRS)), one.file);
    expect(one.asked).toEqual([
      `The engine at ${ENGINE} hands out a different version of this command. Update to it? [Y/n] `,
    ]);
    expect(one.read()).toEqual(THEIRS);
    expect(one.out).toEqual([
      `Updated to the version the engine at ${ENGINE} hands out (${short(digestOf(MINE))} → ${short(digestOf(THEIRS))}).`,
      'It is used from the next command on.',
    ]);
    // It is the engine's now: nothing more is asked.
    await offerUpdate(one.io(engine(THEIRS)), one.file);
    expect(one.asked).toHaveLength(1);
  });

  it('is asked of once when a person says no, and again when the engine has another', async () => {
    const one = installed(false);
    await offerUpdate(one.io(engine(THEIRS)), one.file);
    await offerUpdate(one.io(engine(THEIRS)), one.file);
    expect(one.asked).toHaveLength(1);
    expect(one.out).toEqual(['Not updated. `acentric update` does it whenever you want.']);
    expect(one.read()).toEqual(MINE);

    const NEWER = text('// what the engine hands out after it was upgraded\n');
    await ask(engine(NEWER));
    await offerUpdate(one.io(engine(NEWER)), one.file);
    expect(one.asked).toHaveLength(2);
  });

  it('is not offered when no person is there to answer: nothing is said, and nothing changed', async () => {
    const one = installed();
    await offerUpdate(one.io(engine(THEIRS)), one.file);
    expect(one.out).toEqual([]);
    expect(one.read()).toEqual(MINE);
  });

  it('is not offered to a command that is the engine’s already, or was not installed from one', async () => {
    const same = installed(true);
    writeFileSync(same.file, THEIRS);
    await offerUpdate(same.io(engine(THEIRS)), same.file);
    const other = installed(true);
    await offerUpdate(other.io(engine(THEIRS)), undefined);
    expect([...same.asked, ...other.asked]).toEqual([]);
  });

  it('is not taken when what was fetched is not what the engine said it hands out', async () => {
    const one = installed(true);
    const tampered = engine(text('// something else\n'), THEIRS);
    await expect(offerUpdate(one.io(tampered), one.file)).rejects.toThrow(
      'is not what it said it hands out',
    );
    expect(one.read()).toEqual(MINE);
  });
});

describe('acentric update', () => {
  it('takes what the engine hands out, without asking, and says when it has it already', async () => {
    const one = installed();
    expect(await update(one.io(engine(THEIRS)), { file: one.file, engine: ENGINE })).toBe(
      'updated',
    );
    expect(one.read()).toEqual(THEIRS);
    expect(await update(one.io(engine(THEIRS)), { file: one.file, engine: ENGINE })).toBe('same');
    expect(one.out.at(-1)).toBe(
      `This is the version the engine at ${ENGINE} hands out (${short(digestOf(THEIRS))}).`,
    );
  });

  it('says so of an engine that hands out no command, or cannot be reached, and changes nothing', async () => {
    const one = installed();
    const none = update(one.io(engine(undefined)), { file: one.file, engine: ENGINE });
    await expect(none).rejects.toBeInstanceOf(Fail);
    await expect(none).rejects.toThrow('hands out no command (it answered 404)');
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    };
    await expect(update(one.io(down), { file: one.file, engine: ENGINE })).rejects.toThrow(
      `the engine at ${ENGINE} could not be reached: connect ECONNREFUSED`,
    );
    expect(one.read()).toEqual(MINE);
  });
});

describe('acentric version', () => {
  it('says this command’s version and its engine’s, and whether they are the same', async () => {
    const one = installed();
    const mine = `acentric unbuilt (${short(digestOf(MINE))})`;
    await version(one.io(engine(THEIRS)), { file: one.file, engine: ENGINE });
    expect(one.out.splice(0)).toEqual([
      mine,
      `engine ${ENGINE}: 0.15.0. It hands out a different version of acentric (${short(digestOf(THEIRS))}): \`acentric update\` takes it.`,
    ]);
    await version(one.io(engine(MINE)), { file: one.file, engine: ENGINE });
    expect(one.out.splice(0)).toEqual([
      mine,
      `engine ${ENGINE}: 0.15.0. It hands out this version of acentric.`,
    ]);
    await version(one.io(engine(undefined)), { file: one.file, engine: ENGINE });
    expect(one.out.splice(0)).toEqual([mine, `engine ${ENGINE}: 0.15.0. It hands out no command.`]);
  });

  it('says what it can of a command with no engine, and of an engine that is not there', async () => {
    const one = installed();
    await version(one.io(engine(THEIRS)), { file: undefined, engine: undefined });
    expect(one.out.splice(0)).toEqual(['acentric unbuilt']);
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await version(one.io(down), { file: one.file, engine: ENGINE });
    expect(one.out.at(-1)).toBe(`engine ${ENGINE}: could not be reached`);
  });
});
