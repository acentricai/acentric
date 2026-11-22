// A machine, from nothing to working: it is added with the acentric command, which gives the
// command to run on that computer; that command installs the machine program from the engine
// and enrols; the program connects; and it is updated from the engine when the engine has
// another build. Everything is as it runs: the server, the command, the script and the
// program. The service is left out: the script is told not to make one, and the test runs
// `connect` itself.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { chmod, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import { fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { readSettings, start } from '../src/index.ts';
import type { Started } from '../src/index.ts';

const run = promisify(execFile);
const REPO = join(import.meta.dirname, '..', '..', '..');
const BUILT = join(REPO, 'target', 'debug', 'acentric-machine');
const COMMAND = join(REPO, 'apps', 'cli', 'dist', 'acentric.mjs');
const ADMIN = 'the-key-this-engine-was-started-with';
const MODEL_KEY = 'a-key-the-fake-provider-takes';
const SYSTEM = `${process.platform}-${process.arch}`;

/** The daemon to hand out: the one that was given, or the one built here. Undefined when there is none. */
async function daemonProgram(): Promise<string | undefined> {
  const given = process.env['ACENTRIC_MACHINE_BINARY'];
  if (given !== undefined && given !== '') return given;
  try {
    await run('cargo', ['build', '--package', 'acentric-machine'], { cwd: REPO });
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    if (process.env['CI'] !== undefined) {
      throw new Error('CI has no cargo to build the daemon with', { cause: error });
    }
  }
  return existsSync(BUILT) ? BUILT : undefined;
}

/**
 * Another build of the daemon: the same program with one letter of what it says changed, so
 * that it is another file to an engine and does the same. On macOS it is signed again, as a
 * program that was changed has to be to run.
 */
async function otherBuildOf(program: string, to: string): Promise<void> {
  const bytes = readFileSync(program);
  const at = bytes.indexOf('There is no such method');
  if (at === -1) throw new Error('The daemon does not say what it was expected to');
  bytes[at] = 't'.codePointAt(0) as number;
  await writeFile(to, bytes);
  await chmod(to, 0o755);
  if (process.platform === 'darwin') await run('codesign', ['--force', '--sign', '-', to]);
}

type Ran = { readonly code: number | null; readonly out: string };
type Env = { readonly [name: string]: string };

function sh(command: string, env: Env): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code) => {
      resolve({ code, out });
    });
  });
}

let program: string | undefined;
let dir = '';
let downloads = '';
let up: Started;
let client: Client;
/** The folder of whoever keeps the engine: where the acentric command keeps its key. */
let keeper: Env;
/** The folder of the user of the computer that becomes a machine. */
let machineHome = '';
let machineEnv: Env;
let daemon: ChildProcess | undefined;

/** The acentric command, as the engine hands it out. */
const acentric = (args: string): Promise<Ran> =>
  sh(`'${process.execPath}' '${COMMAND}' ${args}`, keeper);

const machines = async () => (await client.call('machines.list')).items;

function connect(): ChildProcess {
  return spawn(join(machineHome, '.acentric', 'bin', 'machine'), ['connect'], {
    env: {
      ...machineEnv,
      MACHINE_SHELL: '/bin/sh',
      MACHINE_PING_MS: '200',
      MACHINE_RECONNECT_MS: '100',
    },
    stdio: 'ignore',
  });
}

beforeAll(async () => {
  program = await daemonProgram();
  if (program === undefined) return;
  if (!existsSync(COMMAND)) throw new Error(`${COMMAND} is not built: run \`pnpm build\``);
  dir = await realpath(mkdtempSync(join(tmpdir(), 'acentric-install-')));
  // What the server's image has, with the machine program for this system alone.
  downloads = join(dir, 'downloads');
  mkdirSync(join(downloads, 'machine'), { recursive: true });
  copyFileSync(join(REPO, 'apps', 'cli', 'install.sh'), join(downloads, 'install-cli.sh'));
  copyFileSync(COMMAND, join(downloads, 'acentric.mjs'));
  copyFileSync(join(REPO, 'apps', 'machine', 'install.sh'), join(downloads, 'install.sh'));
  await otherBuildOf(program, join(downloads, 'machine', SYSTEM));

  up = await start(
    readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: join(dir, 'data'),
      ACENTRIC_ADMIN_KEY: ADMIN,
      ACENTRIC_SECRET_KEY: 'ab'.repeat(32),
      ACENTRIC_CODE_PROCESSES: '1',
      ACENTRIC_DOWNLOADS: downloads,
    }),
    {
      version: 'test',
      providers: new Providers([
        fakeProvider({ run: async () => says('Nothing to do.') }, { keys: [MODEL_KEY] }),
      ]),
      log: () => {},
      checkAnswers: true,
    },
  );
  client = createClient({ baseUrl: up.server.url, token: ADMIN });
  await client.call('deployments.create', {
    body: {
      agent: 'worker',
      manifest: { protocol: 1, sdk: '0.15.0' },
      code: await bundle('worker'),
    },
  });
  const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const home = join(dir, 'keeper');
  machineHome = join(dir, 'machine-home');
  mkdirSync(home);
  mkdirSync(machineHome);
  keeper = { HOME: home, PATH: path };
  machineEnv = { HOME: machineHome, PATH: path };
}, 300_000);

afterAll(async () => {
  if (program === undefined) return;
  daemon?.kill('SIGTERM');
  await up.close({ graceMs: 100 });
  rmSync(dir, { recursive: true, force: true });
});

describe('a machine, from the acentric command to a program that is connected', () => {
  it('is handed out by the engine: the script with its address, and the program for each system it has', async (context) => {
    if (program === undefined) return context.skip();
    const script = await fetch(`${up.server.url}/install.sh`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    const text = await script.text();
    expect(text).toContain(`SERVER='${up.server.url}'`);
    expect(text).not.toContain('__SERVER__');

    const handed = await fetch(`${up.server.url}/machine/${SYSTEM}`);
    expect(handed.status).toBe(200);
    expect(handed.headers.get('content-type')).toBe('application/octet-stream');
    // Compared as bytes, not shown: a program that was not built small is tens of megabytes.
    expect(
      Buffer.from(await handed.arrayBuffer()).equals(
        readFileSync(join(downloads, 'machine', SYSTEM)),
      ),
    ).toBe(true);
    const none = await fetch(`${up.server.url}/machine/plan9-mips`);
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({
      error: {
        code: 'not_found',
        message: `This engine hands out no machine program for plan9-mips: it has ${SYSTEM}`,
      },
    });
    expect((await fetch(`${up.server.url}/machine/..%2Facentric.mjs`)).status).toBe(404);
  }, 30_000);

  it('is added with a command to run on it, which installs the program and enrols it', async (context) => {
    if (program === undefined) return context.skip();
    expect((await acentric(`login '${up.server.url}' --key '${ADMIN}'`)).code).toBe(0);
    expect((await acentric('machines')).out).toContain('The engine has no machine.');

    // It is for the agents it is said to be for: one has to be said.
    const unsaid = await acentric('machines add build-box');
    expect(unsaid.code).toBe(1);
    expect(unsaid.out).toContain('say which agents the machine is for');
    const unknown = await acentric('machines add build-box --agent nobody');
    expect(unknown.code).toBe(1);

    const added = await acentric('machines add build-box --agent worker');
    expect(added.code, added.out).toBe(0);
    expect(added.out).toContain('Added the machine build-box, for worker.');
    const [machine] = await machines();
    const command = added.out
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('curl '));
    expect(command).toMatch(
      new RegExp(
        `^curl -fsSL ${up.server.url}/install\\.sh \\| sh -s -- --id ${machine?.id ?? ''} --token [0-9a-f]{64}$`,
      ),
    );
    expect((await acentric('machines')).out).toMatch(/build-box\s+not installed\s+1\s+mch_/);

    // On the computer that is to be the machine: a folder of its user's own.
    const installed = await sh(`${command ?? ''} --no-service`, machineEnv);
    expect(installed.code, installed.out).toBe(0);
    const bin = join(machineHome, '.acentric', 'bin', 'machine');
    expect(installed.out).toContain(`Installed ${bin}, version acentric-machine `);
    expect(installed.out).toContain(`Run \`${bin} connect\` to connect it.`);
    expect(readFileSync(bin).equals(readFileSync(join(downloads, 'machine', SYSTEM)))).toBe(true);
    expect(existsSync(join(machineHome, '.acentric', 'machine.json'))).toBe(true);
    expect((await acentric('machines')).out).toMatch(/build-box\s+offline\s+1\s+mch_/);

    // The token worked once: the same command on another computer is refused.
    const other = join(dir, 'other-home');
    mkdirSync(other);
    const again = await sh(`${command ?? ''} --no-service`, { ...machineEnv, HOME: other });
    expect(again.code).not.toBe(0);
    // With no token, a computer that never enrolled has nothing to connect as.
    const bare = await sh(`curl -fsSL '${up.server.url}/install.sh' | sh -s -- --no-service`, {
      ...machineEnv,
      HOME: join(dir, 'other-home'),
    });
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('this machine has not enrolled');
  }, 60_000);

  it('connects, is listed with what it is, and takes the engine’s build of its program when told to', async (context) => {
    if (program === undefined) return context.skip();
    const bin = join(machineHome, '.acentric', 'bin', 'machine');
    // As a machine that was installed from an engine before this one: with another build.
    copyFileSync(program, bin);
    daemon = connect();
    await expect.poll(async () => (await machines())[0]?.online, { timeout: 15_000 }).toBe(true);
    expect((await machines())[0]).toMatchObject({ os: process.platform, current: false });
    const listed = await acentric('machines');
    expect(listed.out).toMatch(
      new RegExp(`build-box\\s+online\\s+${SYSTEM}\\s+\\S+ \\(update available\\)\\s+1\\s+mch_`),
    );

    const updated = await acentric('machines update build-box');
    expect(updated.code, updated.out).toBe(0);
    expect(updated.out).toMatch(/^build-box: updated to \d+\.\d+\.\d+/m);
    // The program on the machine is the engine's now, and it is running as it.
    expect(readFileSync(bin).equals(readFileSync(join(downloads, 'machine', SYSTEM)))).toBe(true);
    expect((await machines())[0]).toMatchObject({ online: true, current: true });
    expect((await acentric('machines')).out).not.toContain('update available');
    expect(daemon.exitCode).toBeNull();

    // There is nothing more to take. With `--all`, one that is away is passed over, and said.
    expect((await acentric('machines add spare --all-agents')).code).toBe(0);
    const all = await acentric('machines update --all');
    expect(all.code, all.out).toBe(0);
    expect(all.out).toMatch(/^build-box: up to date \(/m);
    expect(all.out).toMatch(/^spare: not installed, not updated$/m);
    // Asked for by name, one that is away is a failure to do what was asked.
    const away = await acentric('machines update spare');
    expect(away.code).toBe(1);
    expect(away.out).toContain('is not connected');
    expect((await acentric('machines remove spare')).code).toBe(0);
    const neither = await acentric('machines update');
    expect(neither.code).toBe(1);

    // The script, run again with no token, puts the engine's program in place as an update does.
    copyFileSync(program, join(dir, 'old-program'));
    const again = await sh(
      `curl -fsSL '${up.server.url}/install.sh' | sh -s -- --no-service`,
      machineEnv,
    );
    expect(again.code, again.out).toBe(0);
    expect(readFileSync(bin).equals(readFileSync(join(downloads, 'machine', SYSTEM)))).toBe(true);
  }, 90_000);

  it('is removed, and its program is taken off the computer by the script', async (context) => {
    if (program === undefined) return context.skip();
    const removed = await acentric('machines remove build-box');
    expect(removed.code, removed.out).toBe(0);
    expect(removed.out).toContain('Removed the machine build-box.');
    expect(await machines()).toEqual([]);
    expect((await acentric('machines remove build-box')).code).toBe(1);

    daemon?.kill('SIGTERM');
    const gone = await sh(
      `curl -fsSL '${up.server.url}/install.sh' | sh -s -- --uninstall`,
      machineEnv,
    );
    expect(gone.code, gone.out).toBe(0);
    expect(existsSync(join(machineHome, '.acentric', 'bin'))).toBe(false);
    // The enrolment is kept: it is the user's to forget.
    expect(existsSync(join(machineHome, '.acentric', 'machine.json'))).toBe(true);
  }, 60_000);
});
