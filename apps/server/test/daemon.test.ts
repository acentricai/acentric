// The daemon itself, the program, against the whole server as it runs: it enrols with a token,
// connects, and runs the commands an actor's model asks for with `bash`, on this computer.
// Only the model is a stand-in.
//
// The daemon is built here when it is not given: `cargo build`, which is quick when it is
// built already. Where there is no cargo and no daemon, these tests are passed over, but for
// CI, where one of the two is always there.

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import type { ModelAnswer, ModelRunner, ModelStep } from '@acentric/ai';
import { calls, fakeProvider, says } from '@acentric/ai/testing';
import { createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import type { ActorId, ConversationEntry, MachineId } from '@acentric/protocol';

import { bundle } from '../../../packages/executor/test/bundle.ts';
import { readSettings, start } from '../src/index.ts';
import type { Started } from '../src/index.ts';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILT = join(ROOT, 'target', 'debug', 'acentric-machine');
const MODEL_KEY = 'a-key-the-fake-provider-takes';

/** The daemon to run: the one that was given, or the one built here. Undefined when there is none to be had. */
async function daemonProgram(): Promise<string | undefined> {
  const given = process.env['ACENTRIC_MACHINE_BINARY'];
  if (given !== undefined && given !== '') return given;
  try {
    await run('cargo', ['build', '--package', 'acentric-machine'], { cwd: ROOT });
  } catch (error) {
    // No cargo on this computer: the daemon as it was last built, if it was.
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    if (process.env['CI'] !== undefined) {
      throw new Error('CI has no cargo to build the daemon with', { cause: error });
    }
  }
  return existsSync(BUILT) ? BUILT : undefined;
}

/** What the model does next, by what it was last told: a test writes one of these for each turn. */
type Plan = (step: ModelStep, told: string) => ModelAnswer;
let plan: Plan = () => says('Nothing to do.');
const model: ModelRunner = {
  async run(step) {
    const told = partsOf(step.messages.at(-1))
      .map((part) => part.text ?? '')
      .join('');
    return plan(step, told);
  },
};

/** The parts of a message that has content. */
const partsOf = (message: object | undefined): readonly { type: string; text?: string }[] =>
  (message as { content?: readonly { type: string; text?: string }[] } | undefined)?.content ?? [];

const textOf = (entry: ConversationEntry | undefined): string =>
  partsOf(entry?.message)
    .map((part) => part.text ?? '')
    .join('');

let program: string | undefined;
let dir: string;
let work: string;
let up: Started;
let client: Client;
let agentId: string;
let machineId: MachineId;
let daemon: ChildProcess | undefined;
let daemonLog = '';

/** Starts the daemon's `connect`, as its service would. */
function connect(): ChildProcess {
  const child = spawn(program as string, ['connect'], {
    env: {
      ...process.env,
      MACHINE_DIR: join(dir, 'machine'),
      MACHINE_SHELL: '/bin/sh',
      MACHINE_PING_MS: '200',
      MACHINE_RECONNECT_MS: '100',
      MACHINE_STOP_GRACE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (daemonLog += String(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => (daemonLog += String(chunk)));
  return child;
}

async function stopDaemon(): Promise<void> {
  const child = daemon;
  daemon = undefined;
  if (child === undefined || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await gone;
}

const online = async (): Promise<boolean> =>
  (await client.call('machines.get', { params: { machine: machineId } })).online;

/** Sends an actor a message, and waits until its turn has ended. */
async function turn(actor: ActorId, text: string): Promise<void> {
  const before = (await client.call('actors.get', { params: { actor } })).lastTurn?.at ?? 0;
  await client.call('inputs.send', {
    params: { actor },
    body: { type: 'message', payload: { text } },
  });
  await expect
    .poll(
      async () => {
        const now = await client.call('actors.get', { params: { actor } });
        return now.status === 'idle' && (now.lastTurn?.at ?? 0) > before;
      },
      { timeout: 20_000, interval: 25 },
    )
    .toBe(true);
}

const conversation = async (actor: ActorId) =>
  (await client.call('messages.list', { params: { actor }, query: { limit: 200 } })).items;

const results = async (actor: ActorId) =>
  (await conversation(actor)).filter((entry) => entry.message.role === 'tool_result').map(textOf);

beforeAll(async () => {
  program = await daemonProgram();
  if (program === undefined) return;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'acentric-daemon-')));
  work = join(dir, 'work');
  await mkdir(work);
  up = await start(
    readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_DATA: join(dir, 'data'),
      ACENTRIC_SECRET_KEY: 'ab'.repeat(32),
      ACENTRIC_CODE_PROCESSES: '1',
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
}, 300_000);

afterAll(async () => {
  if (program === undefined) return;
  await stopDaemon();
  await up.close({ graceMs: 100 });
  await rm(dir, { recursive: true, force: true });
});

describe('the daemon, against a server', () => {
  it('enrols with its machine’s token, connects, and says what the machine is', async (context) => {
    if (program === undefined) return context.skip();
    const added = await client.call('machines.create', {
      body: { name: 'this-computer', agents: [agentId as never] },
    });
    machineId = added.machine.id;
    const env = { ...process.env, MACHINE_DIR: join(dir, 'machine') };
    const enrol = (token: string) =>
      run(
        program as string,
        ['enrol', '--server', up.server.url, '--id', machineId, '--token', token],
        {
          env,
        },
      );
    // With what is not its token, it is refused, and is told so.
    await expect(enrol('not-the-token')).rejects.toMatchObject({ code: 1 });
    await enrol(added.token);
    expect(await client.call('machines.get', { params: { machine: machineId } })).toMatchObject({
      enrolled: true,
      online: false,
    });

    daemon = connect();
    await expect.poll(online, { timeout: 10_000, interval: 25 }).toBe(true);
    const machine = await client.call('machines.get', { params: { machine: machineId } });
    expect(machine).toMatchObject({
      os: process.platform,
      arch: process.arch,
      home: process.env['HOME'],
      // This engine hands out no daemon: whether this one is the newest is not known.
      current: null,
    });
    expect(machine.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(machine.hostname).not.toBe('');
  });

  it('runs an actor’s commands with bash: where it works, with its variables, and says how each ended', async (context) => {
    if (program === undefined) return context.skip();
    const { actor } = await client.call('actors.create', {
      params: { agent: agentId as never },
      body: { machine: { id: machineId, cwd: work, env: { GREETING: 'hello', HOME_OF: 'tests' } } },
    });

    plan = (step, told) => {
      const asked = step.messages.filter((message) => message.role === 'tool_result').length;
      if (asked === 0) {
        return calls({
          id: 'c1',
          name: 'bash',
          arguments: { command: 'echo "$GREETING from $(pwd)"; echo kept > note.txt' },
        });
      }
      if (asked === 1)
        return calls({ id: 'c2', name: 'bash', arguments: { command: 'cat note.txt; exit 3' } });
      if (asked === 2) {
        return calls({ id: 'c3', name: 'bash', arguments: { command: 'pwd', cwd: '..' } });
      }
      return says(`Done: ${told}`);
    };
    await turn(actor.id, 'Work.');
    const [first, second, third] = await results(actor.id);
    expect(first).toBe(`hello from ${work}`);
    expect(second).toMatch(/^kept\n\[exit 3 · \d+ms\]$/);
    expect(third).toBe(dir);
    expect(await readFile(join(work, 'note.txt'), 'utf8')).toBe('kept\n');

    // The model was told where it works, by what the daemon said of the machine.
    const system = process.platform === 'darwin' ? 'macOS' : 'Linux';
    const arch = process.arch;
    const tasks = await client.call('tasks.list', { params: { actor: actor.id } });
    expect(tasks.items.map((task) => [task.id, task.kind, task.status])).toEqual([
      ['b3', 'bash', 'done'],
      ['b2', 'bash', 'done'],
      ['b1', 'bash', 'done'],
    ]);
    plan = (step) => {
      expect(step.instructions).toContain(
        `It runs ${system} (${arch}), and your working directory is ${work}.`,
      );
      return says('I know where I am.');
    };
    await turn(actor.id, 'Where are you?');
    expect(textOf((await conversation(actor.id)).at(-1))).toBe('I know where I am.');
  }, 60_000);

  it('shows the model the images a command showed with `show`, with its result', async (context) => {
    if (program === undefined) return context.skip();
    const { actor } = await client.call('actors.create', {
      params: { agent: agentId as never },
      body: { modelId: 'fake-eyes', machine: { id: machineId, cwd: work } },
    });
    // A GIF of 1 pixel, as its file starts.
    const dot = String.raw`printf 'GIF89a\001\000\001\000\000\000' > dot.gif`;
    let shown: object | undefined;
    plan = (step) => {
      expect(step.instructions).toContain('- `show <file>...` in a command shows you images');
      const asked = step.messages.filter((message) => message.role === 'tool_result');
      if (asked.length === 0) {
        return calls({
          id: 'c1',
          name: 'bash',
          arguments: { command: `${dot} && show dot.gif && echo shown; show none.png` },
        });
      }
      shown = asked[0];
      return says('A dot.');
    };
    await turn(actor.id, 'Draw a dot, and look at it.');
    // The model is sent the image itself, after what the command wrote.
    expect(shown).toMatchObject({
      content: [
        { type: 'text', text: 'shown\nshow: there is no file none.png\n' },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/gif',
            data: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1').toString('base64'),
          },
        },
        { type: 'text', text: expect.stringMatching(/^\n\[exit 1 · \d+ms\]$/) },
      ],
    });
    // Read as text, the image is left out from between them.
    expect((await results(actor.id)).at(-1)).toMatch(
      /^shown\nshow: there is no file none\.png\n\n\[exit 1 · \d+ms\]$/,
    );
  }, 60_000);

  it('lets a command go on in the background, tells of its ending, and stops one when asked', async (context) => {
    if (program === undefined) return context.skip();
    const { actor } = await client.call('actors.create', {
      params: { agent: agentId as never },
      body: { machine: { id: machineId, cwd: work } },
    });

    // It starts a command without waiting, ends its turn, and is woken by the ending.
    let woken = '';
    plan = (step, told) => {
      const last = step.messages.at(-1);
      if (last?.role === 'user' && told === 'Build.') {
        return calls({
          id: 'c1',
          name: 'bash',
          arguments: { command: 'sleep 0.3; echo built > out.txt; echo finished', wait: 0 },
        });
      }
      if (last?.role === 'tool_result') return says('It is building.');
      woken = told;
      return says('It built.');
    };
    await turn(actor.id, 'Build.');
    expect((await results(actor.id))[0]).toMatch(/b1/);
    await expect
      .poll(async () => textOf((await conversation(actor.id)).at(-1)), { timeout: 20_000 })
      .toBe('It built.');
    expect(woken).toMatch(
      /<task id="b1" kind="bash" status="done" ran="[^"]+">\n\$ sleep 0\.3; echo built > out\.txt; echo finished\nfinished\n<\/task>/,
    );
    expect(await readFile(join(work, 'out.txt'), 'utf8')).toBe('built\n');

    // One that would run for long is stopped, with everything it started.
    plan = (step) => {
      const before = step.messages.findLastIndex((message) => message.role === 'user');
      const inTurn = step.messages.slice(before + 1).filter((m) => m.role === 'tool_result').length;
      if (inTurn === 0) {
        return calls({
          id: 'c2',
          name: 'bash',
          arguments: { command: 'echo started; sleep 300 & wait', wait: 0 },
        });
      }
      // Time for it to have said something.
      if (inTurn === 1)
        return calls({ id: 'c3', name: 'bash', arguments: { command: 'sleep 0.5' } });
      if (inTurn === 2) return calls({ id: 'c4', name: 'stop', arguments: { task: 'b2' } });
      return says('Stopped.');
    };
    await turn(actor.id, 'Start something long, then stop it.');
    const stopped = (await results(actor.id)).at(-1) ?? '';
    expect(stopped).toMatch(/^stopped b2 after /);
    expect(stopped).toContain('started');
    expect(
      await client.call('tasks.get', { params: { actor: actor.id, task: 'b2' } }),
    ).toMatchObject({
      status: 'stopped',
    });

    // A command stopped at its timeout says so.
    plan = (step) =>
      step.messages.at(-1)?.role === 'user'
        ? calls({
            id: 'c4',
            name: 'bash',
            arguments: { command: 'echo waiting; sleep 300', timeout: 1 },
          })
        : says('It timed out.');
    await turn(actor.id, 'Wait for too long.');
    // On Linux, bash says of a command it was running that it was terminated.
    expect((await results(actor.id)).at(-1)).toMatch(
      /^waiting\n(?:Terminated\n)?\[stopped: timed out after \S+\]$/,
    );
  }, 90_000);

  it('runs commands of the machine’s own from outside, and reads and writes its files', async (context) => {
    if (program === undefined) return context.skip();
    const params = { machine: machineId };
    const ran = await client.call('machineCommands.run', {
      params,
      body: { command: 'echo hi; pwd' },
    });
    expect(ran).toMatchObject({
      id: 'c1',
      machine: machineId,
      cwd: '~',
      status: 'exited',
      exit: 0,
      tail: `hi\n${process.env['HOME'] ?? ''}\n`,
    });

    // One that outlasts its wait goes on, and is read, waited for and stopped by its ID.
    const slow = await client.call('machineCommands.run', {
      params,
      body: { command: 'echo begun; sleep 0.6; echo late', cwd: work, wait: 0.2 },
    });
    expect(slow).toMatchObject({ id: 'c2', status: 'running', output: 'begun\n' });
    const later = await client.call('machineCommands.get', {
      params: { ...params, command: 'c2' },
      query: { wait: 10 },
    });
    expect(later).toMatchObject({ status: 'exited', tail: 'begun\nlate\n' });
    expect(later).not.toHaveProperty('output');

    const long = await client.call('machineCommands.run', {
      params,
      body: { command: 'echo started; sleep 300', wait: 0.3 },
    });
    expect(long).toMatchObject({ id: 'c3', status: 'running' });
    const stopped = await client.call('machineCommands.stop', {
      params: { ...params, command: 'c3' },
    });
    expect(stopped).toMatchObject({ status: 'stopped', stoppedBy: 'stop' });
    // On Linux, bash says of a command it was running that it was terminated.
    expect(stopped.tail).toMatch(/^started\n(?:Terminated\n)?$/);

    // At its timeout it is stopped by the machine, and where there is no such folder it is not run.
    expect(
      await client.call('machineCommands.run', {
        params,
        body: { command: 'sleep 300', timeout: 0.3 },
      }),
    ).toMatchObject({ status: 'stopped', stoppedBy: 'timeout' });
    const nowhere = await client.call('machineCommands.run', {
      params,
      body: { command: 'true', cwd: '/no/such/folder' },
    });
    expect(nowhere).toMatchObject({ id: 'c5', status: 'failed' });
    expect(nowhere.error).toContain('/no/such/folder');

    const listed = await client.call('machineCommands.list', { params, query: { limit: 3 } });
    expect(listed.items.map((command) => command.id)).toEqual(['c5', 'c4', 'c3']);
    const code = (call: Promise<unknown>) =>
      call.then(
        () => 'answered',
        (error: unknown) => (error as { code: string }).code,
      );
    expect(
      await code(client.call('machineCommands.get', { params: { ...params, command: 'c99' } })),
    ).toBe('not_found');
    expect(
      await code(client.call('machineCommands.run', { params, body: { command: '  ' } })),
    ).toBe('invalid_request');

    // Files: the bytes sent, folders and all, and read back as they are.
    const headers = { authorization: `Bearer ${up.firstKey ?? ''}` };
    const file = join(dir, 'files', 'deep', 'a.bin');
    const url = (query: string) =>
      `${up.server.url}/v1/machines/${machineId}/files?path=${encodeURIComponent(file)}${query}`;
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 7]);
    const written = await fetch(url(''), { method: 'PUT', headers, body: bytes });
    expect(written.status).toBe(200);
    expect(await written.json()).toEqual({ path: file, size: 7 });
    expect(await readFile(file)).toEqual(bytes);
    // More, after its end.
    const more = await fetch(url('&from=7'), { method: 'PUT', headers, body: Buffer.from('xyz') });
    expect(await more.json()).toEqual({ path: file, size: 10 });

    const read = await fetch(url(''), { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get('x-file-size')).toBe('10');
    expect(Buffer.from(await read.arrayBuffer())).toEqual(
      Buffer.concat([bytes, Buffer.from('xyz')]),
    );
    const part = await fetch(url('&from=7&max=2'), { headers });
    expect(await part.text()).toBe('xy');
    expect(part.headers.get('x-file-from')).toBe('7');

    const missing = await fetch(
      `${up.server.url}/v1/machines/${machineId}/files?path=${encodeURIComponent(join(dir, 'none'))}`,
      { headers },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
    const large = await fetch(url(''), {
      method: 'PUT',
      headers,
      body: Buffer.alloc((8 << 20) + 1),
    });
    expect(large.status).toBe(413);
    expect((await fetch(url(''))).status).toBe(401);

    // They are for a key of the whole engine that has machines:run.
    const made = await client.call('keys.create', {
      body: { label: 'reads', scope: { type: 'engine' }, permissions: ['machines:manage'] },
    });
    const keeper = createClient({ baseUrl: up.server.url, token: made.token });
    expect(await code(keeper.call('machineCommands.list', { params }))).toBe('forbidden');
    expect(
      (await fetch(url(''), { headers: { authorization: `Bearer ${made.token}` } })).status,
    ).toBe(403);
  }, 90_000);

  it('lets an agent’s own code read and write files there, from its actor’s working directory', async (context) => {
    if (program === undefined) return context.skip();
    const deployed = await client.call('deployments.create', {
      body: {
        agent: 'keeper',
        manifest: { protocol: 1, sdk: '0.15.0' },
        code: await bundle('files'),
      },
    });
    const keeper = deployed.agent.id;
    await client.call('machines.update', {
      params: { machine: machineId },
      body: { agents: [agentId as never, keeper] },
    });
    const { actor } = await client.call('actors.create', {
      params: { agent: keeper },
      body: { machine: { id: machineId, cwd: work, env: { GREETING: 'hello' } } },
    });
    /** One turn in which the model calls these tools of the agent, one after the other. */
    const tools = async (...asked: [name: string, args: { [name: string]: unknown }][]) => {
      const before = (await results(actor.id)).length;
      plan = (step) => {
        const done =
          step.messages.filter((message) => message.role === 'tool_result').length - before;
        const next = asked[done];
        return next === undefined
          ? says('Done.')
          : calls({ id: `k${String(before + done)}`, name: next[0], arguments: next[1] as never });
      };
      await turn(actor.id, 'Keep.');
      return (await results(actor.id)).slice(before);
    };

    // Text, with the folders it needs made, and a path of its own where its code says one.
    const apart = join(dir, 'apart', 'top.txt');
    expect(
      await tools(
        ['save', { path: 'notes/today.txt', text: 'buy bolts ✓' }],
        ['save', { path: apart, text: 'apart' }],
        ['load', { path: 'notes/today.txt' }],
        ['load', { path: apart }],
      ),
    ).toEqual(['saved notes/today.txt', `saved ${apart}`, 'buy bolts ✓', 'apart']);
    expect(await readFile(join(work, 'notes', 'today.txt'), 'utf8')).toBe('buy bolts ✓');
    expect(await readFile(apart, 'utf8')).toBe('apart');

    // Bytes, more than one request carries: 9 MiB is two each way.
    expect(await tools(['big', { bytes: 9 << 20 }])).toEqual([`${String(9 << 20)} true`]);
    const written = await readFile(join(work, 'big.bin'));
    expect(written.length).toBe(9 << 20);
    expect(written[(8 << 20) + 5]).toBe(((8 << 20) + 5) % 251);

    // What is wrong is said to its code: a file that is not there, and one too large for it.
    await writeFile(join(work, 'huge.bin'), Buffer.alloc((32 << 20) + 1));
    const [missing, huge, big] = await tools(
      ['load', { path: 'missing.txt' }],
      ['load', { path: 'huge.bin' }],
      ['big', { bytes: (32 << 20) + 1 }],
    );
    expect(missing).toContain(`There is no file ${join(work, 'missing.txt')}`);
    expect(huge).toContain(
      "huge.bin is 33554433 bytes: an agent's code reads and writes files of at most 32 MiB",
    );
    expect(big).toContain('big.bin is 33554433 bytes');
    // Nothing of a file that is refused was written: the one before it is as it was.
    expect((await readFile(join(work, 'big.bin'))).length).toBe(9 << 20);

    // Its machine is given to it as data, with the variables its commands are run with.
    const [what] = await tools(['what', {}]);
    const machine = { id: machineId, cwd: work, env: { GREETING: 'hello' } };
    expect(JSON.parse(what as string)).toEqual({
      keys: ['id', 'cwd', 'env'],
      spread: machine,
      json: machine,
    });

    // And what an actor is sent is put into a file, where its code turns it into what the model reads.
    plan = () => says('Got it.');
    const before = (await client.call('actors.get', { params: { actor: actor.id } })).lastTurn?.at;
    await client.call('inputs.send', {
      params: { actor: actor.id },
      body: {
        type: 'upload',
        payload: {
          name: 'logo.png',
          base64: Buffer.from([137, 80, 78, 71, 0, 255]).toString('base64'),
        },
      },
    });
    await expect
      .poll(
        async () =>
          (await client.call('actors.get', { params: { actor: actor.id } })).lastTurn?.at !==
          before,
        { timeout: 20_000, interval: 25 },
      )
      .toBe(true);
    expect([...(await readFile(join(work, 'inbox', 'logo.png')))]).toEqual([
      137, 80, 78, 71, 0, 255,
    ]);
    const said = (await conversation(actor.id)).filter((entry) => entry.message.role === 'user');
    expect(textOf(said.at(-1))).toBe('A file is in inbox/logo.png: 6 bytes.');
  }, 90_000);

  it('is told when its machine is away, runs again when it is back, and not at all once it is removed', async (context) => {
    if (program === undefined) return context.skip();
    const { actor } = await client.call('actors.create', {
      params: { agent: agentId as never },
      body: { machine: { id: machineId, cwd: work } },
    });
    plan = (step, told) =>
      step.messages.at(-1)?.role === 'user'
        ? calls({
            id: `c${String(step.messages.length)}`,
            name: 'bash',
            arguments: { command: 'echo here' },
          })
        : says(told);

    await stopDaemon();
    await expect.poll(online, { timeout: 10_000, interval: 25 }).toBe(false);
    await turn(actor.id, 'Anyone there?');
    expect((await results(actor.id)).at(-1)).toBe(
      `Your machine, ${machineId}, is not connected: nothing was run. It may be back later.`,
    );
    expect(
      await client
        .call('machines.upgrade', { params: { machine: machineId } })
        .catch((error: unknown) => (error as { code: string }).code),
    ).toBe('machine_offline');

    daemon = connect();
    await expect.poll(online, { timeout: 10_000, interval: 25 }).toBe(true);
    await turn(actor.id, 'And now?');
    expect((await results(actor.id)).at(-1)).toBe('here');
    // This engine hands out no daemon for it to take.
    expect(
      await client
        .call('machines.upgrade', { params: { machine: machineId } })
        .catch((error: unknown) => (error as { code: string }).code),
    ).toBe('conflict');

    await client.call('machines.delete', { params: { machine: machineId } });
    await turn(actor.id, 'Still?');
    expect((await results(actor.id)).at(-1)).toBe(
      `Your machine, ${machineId}, was removed: nothing was run.`,
    );
    // Its daemon is not taken again: it goes on asking, and is refused.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(daemon.exitCode).toBeNull();
    expect(
      await client
        .call('machines.get', { params: { machine: machineId } })
        .catch((error: unknown) => (error as { code: string }).code),
    ).toBe('not_found');
  }, 90_000);
});
