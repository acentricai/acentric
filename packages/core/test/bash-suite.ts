// An actor on a machine, through the whole engine, on any store: its model runs commands with
// `bash`, and the machine is a daemon of the tests' own (see `fake-daemon.ts`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import type { ActorId, ConversationEntry, Json, MachineId } from '@acentric/protocol';

import type { EngineOptions } from '../src/engine.ts';
import type { CallContext } from '../src/executor.ts';
import { Secrets } from '../src/secrets.ts';
import type { Store } from '../src/store.ts';
import type { TaskTimes } from '../src/tasks.ts';
import type { AgentFunction } from '../src/testing.ts';
import { FakeDaemon } from './fake-daemon.ts';
import { eventually, told, world } from './world.ts';
import type { World } from './world.ts';

/** The tests' agent, as code that says its actors work on a machine. */
const ON_MACHINE = 'orders@machine';
const VERSIONS = { [ON_MACHINE]: { definition: { features: ['machine'] } } };

const bash = (id: string, args: { [name: string]: Json }) =>
  calls({ id, name: 'bash', arguments: args });
const stop = (id: string, task: string) => calls({ id, name: 'stop', arguments: { task } });

/** What a message says, as text. */
function textOf(entry: ConversationEntry | undefined): string {
  const { content } = (entry?.message ?? {}) as {
    content?: readonly { readonly type: string; readonly text?: string }[];
  };
  return (content ?? []).map((part) => part.text ?? `[${part.type}]`).join('');
}

const TIMES: Partial<TaskTimes> = { defaultWaitMs: 5000, floorMs: 60, stopGraceMs: 80 };

export function bashSuite(name: string, open: () => Promise<Store>): void {
  describe(`an actor on a machine, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    let secrets: Secrets;
    let engines: ReturnType<World['engine']>[];

    const engine = (
      script: readonly Scripted[],
      options: Partial<EngineOptions> = {},
      code: { readonly lookup?: AgentFunction; readonly handler?: AgentFunction } = {},
    ) => {
      const one = w.engine(script, {
        ...code,
        versions: VERSIONS,
        options: {
          clock: Date.now,
          taskTimes: TIMES,
          secrets,
          machines: { stopGraceMs: 80, times: { returnMs: 3000 } },
          ...options,
        },
      });
      engines.push(one);
      return one;
    };

    /** An engine whose agent works on machines, a machine that is connected, and an actor on it. */
    const setup = async (
      script: readonly Scripted[],
      more: {
        readonly env?: { readonly [name: string]: string };
        readonly modelId?: string;
        /** The agent's tool, and what makes of what it is sent, as its code has them. */
        readonly lookup?: AgentFunction;
        readonly handler?: AgentFunction;
      } = {},
    ) => {
      const { lookup, handler } = more;
      const one = engine(
        script,
        {},
        {
          ...(lookup === undefined ? {} : { lookup }),
          ...(handler === undefined ? {} : { handler }),
        },
      );
      await one.deploy(ON_MACHINE);
      const machines = one.it.machines;
      if (machines === undefined) throw new Error('The engine keeps no machines');
      const { machine, token } = await machines.add({ name: 'box', agents: '*' });
      const daemon = new FakeDaemon();
      await machines.enrol(machine.id, { token, publicKey: daemon.publicKey });
      await daemon.connect(machines, machine.id);
      await machines.whenOnline(machine.id);
      const actor = await one.createActor({
        machine: {
          id: machine.id,
          cwd: '~/work',
          ...(more.env === undefined ? {} : { env: more.env }),
        },
        ...(more.modelId === undefined ? {} : { modelId: more.modelId }),
      });
      /** Every command ends at once, with what a test says of it. */
      const ends = (how: Parameters<FakeDaemon['end']>[1] = {}) => {
        daemon.onRun = (params) => {
          daemon.end({ actor: String(params['actor']), task: String(params['task']) }, how);
        };
      };
      return { one, machines, daemon, machine: machine.id, actor, ends };
    };

    const results = async (actor: ActorId) =>
      (await store.conversation(actor)).filter((entry) => entry.message.role === 'tool_result');

    beforeEach(async () => {
      store = await open();
      w = world({ store });
      secrets = new Secrets({
        store,
        keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } },
      });
      engines = [];
    });

    afterEach(async () => {
      for (const one of engines) {
        await one.it.close({ graceMs: 50 });
        expect(one.failures).toEqual([]);
      }
      await store.close();
    });

    describe('the tools and the instructions', () => {
      it('have bash and what the harness says of the machine, for an actor that has one', async () => {
        const { one, actor } = await setup([says('Ready.')]);
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);
        const [step] = one.steps;
        expect(step?.tools.map((tool) => tool.name)).toEqual(['lookup_order', 'bash', 'stop']);
        expect(step?.tools[1]).toMatchObject({
          description: expect.stringMatching(/^Runs a command with bash on your machine/),
          parameters: {
            properties: {
              command: { type: 'string' },
              cwd: { type: 'string' },
              wait: { type: 'number' },
              timeout: { type: 'number' },
            },
            required: ['command'],
          },
        });
        expect(step?.instructions).toMatch(/^# How you work here\n/);
        expect(step?.instructions).toContain('# Tasks\n\nA command is a task.');
        expect(step?.instructions).toContain(
          '`bash` runs commands on your machine. It runs Linux (x64), and your working directory is ~/work.',
        );
        expect(step?.instructions).not.toContain('view_image');
        expect(step?.instructions).not.toContain('`schedule`');
        expect(step?.instructions.endsWith('\n\nYou answer questions about orders.')).toBe(true);
      });

      it('have neither for an actor that has none', async () => {
        const one = engine([says('Ready.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);
        expect(one.steps[0]?.tools.map((tool) => tool.name)).toEqual(['lookup_order']);
        expect(one.steps[0]?.instructions).toBe(told('You answer questions about orders.'));
        expect(one.steps[0]?.instructions).not.toContain('# Your machine');
        expect(one.steps[0]?.instructions).not.toContain('# Tasks');
      });

      it('say where the machine is as far as it is known: nothing of one whose daemon never connected', async () => {
        const one = engine([says('Ready.')]);
        await one.deploy(ON_MACHINE);
        const added = await one.it.machines?.add({ name: 'box', agents: '*' });
        const id = added?.machine.id as MachineId;
        const actor = await one.createActor({ machine: { id, cwd: '/srv/app' } });
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);
        expect(one.steps[0]?.instructions).toContain(
          '`bash` runs commands on your machine. Your working directory is /srv/app.',
        );
      });
    });

    describe('bash', () => {
      it('runs a command on the machine, and answers with what it wrote', async () => {
        const { one, actor, daemon, machine, ends } = await setup([
          bash('c1', { command: 'echo hi' }),
          says('It said hi.'),
        ]);
        ends({ tail: 'hi\n', bytes: 3, lines: 1 });
        await one.say(actor.id, 'Say hi.');
        await one.it.settled(actor.id);

        expect(daemon.asked('run')).toEqual([
          { actor: actor.id, task: 'b1', command: 'echo hi', cwd: '~/work' },
        ]);
        const [result] = await results(actor.id);
        expect(result?.message).toMatchObject({ toolName: 'bash', isError: false });
        expect(textOf(result)).toBe('hi');
        expect(await one.it.tasks.get(actor.id, 'b1')).toMatchObject({
          kind: 'bash',
          status: 'done',
          input: { machine, command: 'echo hi', cwd: '~/work' },
        });
      });

      it('says how a command ended that did not end well, without calling it a failure of the tool', async () => {
        const { one, actor, daemon } = await setup([
          bash('c1', { command: 'false' }),
          bash('c2', { command: 'true' }),
          says('Done.'),
        ]);
        daemon.onRun = (params) => {
          const ref = { actor: String(params['actor']), task: String(params['task']) };
          if (params['command'] === 'false') {
            daemon.end(ref, { exit: 1, tail: 'boom\n', bytes: 5, lines: 1, ranMs: 2300 });
          } else {
            daemon.end(ref, { exit: 0, tail: '', bytes: 0, lines: 0 });
          }
        };
        await one.say(actor.id, 'Try.');
        await one.it.settled(actor.id);
        const [failed, silent] = await results(actor.id);
        expect(textOf(failed)).toBe('boom\n[exit 1 · 2s]');
        expect(failed?.message).toMatchObject({ isError: false });
        expect(textOf(silent)).toBe('(no output)');
      });

      it("starts in the actor's working directory, or where the call says, from there", async () => {
        const { one, actor, daemon, ends } = await setup([
          bash('c1', { command: 'pwd', cwd: 'src/lib' }),
          bash('c2', { command: 'pwd', cwd: '/etc' }),
          bash('c3', { command: 'pwd', cwd: '~/other' }),
          bash('c4', { command: 'pwd', cwd: '..', timeout: 30 }),
          says('Done.'),
        ]);
        ends();
        await one.say(actor.id, 'Where?');
        await one.it.settled(actor.id);
        expect(daemon.asked('run').map((params) => params['cwd'])).toEqual([
          '~/work/src/lib',
          '/etc',
          '~/other',
          '~',
        ]);
        // The machine keeps the timeout: it is sent with the command.
        expect(daemon.asked('run').map((params) => params['timeout'])).toEqual([
          undefined,
          undefined,
          undefined,
          30,
        ]);
      });

      it('answers with what is wrong when a call cannot be a command', async () => {
        const { one, actor, daemon } = await setup([
          bash('c1', { command: '  ' }),
          bash('c2', { command: 'ls', dir: '/tmp' }),
          bash('c3', { command: 'ls', cwd: 7 }),
          says('I see.'),
        ]);
        await one.say(actor.id, 'Go.');
        await one.it.settled(actor.id);
        const answers = (await results(actor.id)).map(textOf);
        expect(answers).toEqual([
          'The arguments of bash are not valid: command is a string that is not empty',
          'The arguments of bash are not valid: dir is not known',
          'The arguments of bash are not valid: cwd is a path',
        ]);
        expect(daemon.asked('run')).toEqual([]);
      });

      it('carries the end of long output, and says where all of it is', async () => {
        const { one, actor, ends } = await setup([bash('c1', { command: 'seq' }), says('Long.')]);
        const tail = Array.from({ length: 412 }, (_, index) => `line ${String(index)}`).join('\n');
        ends({ tail: `${tail}\n`, bytes: 2_000_000, lines: 14_210 });
        await one.say(actor.id, 'Count.');
        await one.it.settled(actor.id);
        const text = textOf((await results(actor.id))[0]);
        // The machine sent the end alone, from the middle of a line: that line is left out.
        expect(text.startsWith('line 1\nline 2\n')).toBe(true);
        expect(
          text.endsWith(
            `line 411\n[showing the last 411 lines of 14,210 · all of it: ~/.acentric-machine/tasks/${actor.id}/b1/output.log]`,
          ),
        ).toBe(true);
      });

      it('is stopped by the machine at its timeout, and says so', async () => {
        const { one, actor, ends } = await setup([
          bash('c1', { command: 'sleep 60', timeout: 30 }),
          says('Too slow.'),
        ]);
        ends({ status: 'stopped', by: 'timeout', exit: null, tail: 'so far\n', ranMs: 30_000 });
        await one.say(actor.id, 'Wait.');
        await one.it.settled(actor.id);
        expect(textOf((await results(actor.id))[0])).toMatch(
          /^so far\n\[stopped: timed out after \d+ms\]$/,
        );
        expect(await one.it.tasks.get(actor.id, 'b1')).toMatchObject({
          status: 'stopped',
          stoppedBy: 'timeout',
        });
      });

      it('is started without waiting with a wait of 0, and a notice says how it ended', async () => {
        const { one, actor, daemon } = await setup([
          bash('c1', { command: 'make build\nmake test', wait: 0 }),
          says('It is building.'),
          says('It built.'),
        ]);
        await one.say(actor.id, 'Build.');
        await one.it.settled(actor.id);
        const log = `~/.acentric-machine/tasks/${actor.id}/b1/output.log`;
        expect(textOf((await results(actor.id))[0])).toContain('b1');
        expect(textOf((await results(actor.id))[0])).toContain(`log ${log}`);
        // It is listed while it runs, with how it starts and where its output is.
        expect((await one.it.tasks.describe(actor.id)).join('\n')).toMatch(
          new RegExp(`^b1 bash.*\\$ make build ….*log ${log.replaceAll('.', '\\.')}`),
        );

        daemon.end({ actor: actor.id, task: 'b1' }, { tail: 'built\n', ranMs: 4200 });
        await eventually(
          async () => (await w.roles(actor.id)).at(-1) === 'assistant' && one.steps.length === 3,
        );
        await one.it.settled(actor.id);
        const notice = (await store.conversation(actor.id)).find(
          (entry) => entry.message.role === 'system',
        );
        expect(textOf(notice)).toMatch(
          /^<task id="b1" kind="bash" status="done" ran="[^"]+">\n\$ make build …\nbuilt\n<\/task>$/,
        );
      });

      it('is stopped by the model, which is told how far it got', async () => {
        const { one, actor, daemon } = await setup([
          bash('c1', { command: 'sleep 600', wait: 0 }),
          stop('c2', 'b1'),
          says('Stopped it.'),
        ]);
        await one.say(actor.id, 'Start and stop.');
        await one.it.settled(actor.id);
        expect(daemon.asked('stop')).toEqual([{ actor: actor.id, task: 'b1' }]);
        expect(textOf((await results(actor.id))[1])).toMatch(/^stopped b1 after \S+\nso far$/);
        expect(await one.it.tasks.get(actor.id, 'b1')).toMatchObject({ status: 'stopped' });
      });

      it('is answered at once with what is wrong when the machine is not connected, or is gone', async () => {
        const { one, actor, daemon, machines, machine } = await setup([
          bash('c1', { command: 'ls' }),
          says('It is away.'),
          bash('c2', { command: 'ls' }),
          says('It is gone.'),
        ]);
        daemon.drop();
        await machines.whenOffline(machine);
        await one.say(actor.id, 'List.');
        await one.it.settled(actor.id);
        const [offline] = await results(actor.id);
        expect(textOf(offline)).toBe(
          `Your machine, ${machine}, is not connected: nothing was run. It may be back later.`,
        );
        expect(offline?.message).toMatchObject({ isError: true });

        await machines.remove(machine);
        await one.say(actor.id, 'Again.');
        await one.it.settled(actor.id);
        expect(textOf((await results(actor.id))[1])).toBe(
          `Your machine, ${machine}, was removed: nothing was run.`,
        );
      });

      it('goes on through a lost connection, and its call is answered when the machine is back', async () => {
        const { one, actor, daemon, machines, machine } = await setup([
          bash('c1', { command: 'make' }),
          says('Made.'),
        ]);
        await one.say(actor.id, 'Make.');
        await eventually(() => daemon.running.size === 1);
        daemon.drop();
        await machines.whenOffline(machine);
        daemon.end({ actor: actor.id, task: 'b1' }, { tail: 'made\n' });
        await daemon.connect(machines, machine);
        await one.it.settled(actor.id);
        expect(textOf((await results(actor.id))[0])).toBe('made');
        expect(daemon.asked('run')).toHaveLength(1);
      });

      it('goes on through a stop of the engine: the next one answers its call, and the command ran once', async () => {
        const first = await setup([bash('c1', { command: 'make' })]);
        const { actor, daemon, machine } = first;
        await first.one.say(actor.id, 'Make.');
        await eventually(() => daemon.running.size === 1);
        await first.one.it.close({ graceMs: 20 });
        expect(daemon.link).toBeUndefined();

        const second = engine([says('Made.')]);
        const recovering = second.it.recover();
        const machines = second.it.machines;
        if (machines === undefined) throw new Error('The engine keeps no machines');
        await daemon.connect(machines, machine);
        await recovering;
        daemon.end({ actor: actor.id, task: 'b1' }, { tail: 'made\n' });
        await eventually(async () => (await results(actor.id)).length === 1);
        await second.it.settled(actor.id);
        expect(textOf((await results(actor.id))[0])).toBe('made');
        expect(daemon.asked('run')).toHaveLength(1);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
      });
    });

    describe('view_image', () => {
      const view = (id: string, args: { [name: string]: Json }) =>
        calls({ id, name: 'view_image', arguments: args });
      /** A PNG of a size, as its file starts: enough to know it by. */
      const png = (width: number, height: number): Buffer => {
        const bytes = Buffer.alloc(64);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
        bytes.writeUInt32BE(width, 16);
        bytes.writeUInt32BE(height, 20);
        return bytes;
      };

      it('is offered to a model that takes images, on a machine, and to no other', async () => {
        const { one, actor } = await setup([says('Ready.')], { modelId: 'fake-eyes' });
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);
        expect(one.steps[0]?.tools.map((tool) => tool.name)).toEqual([
          'lookup_order',
          'bash',
          'stop',
          'view_image',
        ]);
        expect(one.steps[0]?.instructions).toContain(
          '- `view_image` shows you an image file from the machine.',
        );
        // The same model with no machine has no file to be shown.
        await one.it.activate((await one.agent()).id, 1);
        const plain = await one.createActor({ modelId: 'fake-eyes', version: 1 });
        await one.say(plain.id, 'Hello.');
        await one.it.settled(plain.id);
        expect(one.steps[1]?.tools.map((tool) => tool.name)).toEqual(['lookup_order']);
      });

      it('shows the model an image from the machine, as the result of its call', async () => {
        const { one, actor, daemon } = await setup(
          [view('c1', { path: 'shots/home.png' }), says('A home page.')],
          { modelId: 'fake-eyes' },
        );
        daemon.files.set('shots/home.png', png(1280, 720));
        await one.say(actor.id, 'Look.');
        await one.it.settled(actor.id);
        expect(daemon.asked('read')).toEqual([
          { path: 'shots/home.png', cwd: '~/work', max: 5 * 1024 * 1024 + 1 },
        ]);
        const [result] = await results(actor.id);
        expect(result?.message).toMatchObject({
          toolName: 'view_image',
          isError: false,
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                mediaType: 'image/png',
                data: png(1280, 720).toString('base64'),
              },
            },
          ],
        });
        // The model is sent it with its next call.
        expect(JSON.stringify(one.steps[1]?.messages.at(-1))).toContain('image/png');
      });

      it('answers with what is wrong when there is no image to show', async () => {
        const { one, actor, daemon, machines, machine } = await setup(
          [
            view('c1', { path: 'notes.txt' }),
            view('c2', { path: 'huge.png' }),
            view('c3', { path: 'gone.png' }),
            view('c4', { file: 'a.png' }),
            view('c5', { path: 'a.png', scale: 2 }),
            says('I see.'),
            view('c6', { path: 'shot.png' }),
            says('Away.'),
          ],
          { modelId: 'fake-eyes' },
        );
        daemon.files.set('notes.txt', Buffer.from('not an image'));
        daemon.files.set('huge.png', Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]));
        daemon.refuse = (method, params) =>
          method === 'read' && params['path'] === 'gone.png'
            ? { code: 'not_found', message: 'There is no file gone.png' }
            : undefined;
        await one.say(actor.id, 'Look at these.');
        await one.it.settled(actor.id);
        const shown = await results(actor.id);
        expect(shown.map(textOf)).toEqual([
          'notes.txt is not a png, jpeg, gif or webp image',
          'huge.png is 5.0 MB, and the largest image that can be shown is 5.0 MB',
          'There is no file gone.png',
          'path is the path of a file',
          'scale is not known',
        ]);
        expect(shown.every((result) => (result.message as { isError?: boolean }).isError)).toBe(
          true,
        );

        daemon.drop();
        await machines.whenOffline(machine);
        await one.say(actor.id, 'And this.');
        await one.it.settled(actor.id);
        expect(textOf((await results(actor.id)).at(-1))).toBe(
          `Your machine, ${machine}, is not connected: the file could not be read.`,
        );
      });
    });

    describe('an agent’s code', () => {
      const tool = (id: string, args: { [name: string]: Json } = {}) =>
        calls({ id, name: 'lookup_order', arguments: args });
      const base64 = (text: string) => Buffer.from(text).toString('base64');
      /** A tool that writes what it is given to a file, and answers with what the file then has. */
      const keeps: AgentFunction = async (args, _context, _signal, host) => {
        const { path, text } = args as { path: string; text: string };
        const data = base64(text);
        await host.file({ op: 'write', path, from: 0, size: text.length, data });
        const read = await host.file({ op: 'read', path, from: 0 });
        return `${String(read?.size)}: ${Buffer.from(read?.data ?? '', 'base64').toString()}`;
      };

      it('reads and writes the files of its actor’s machine, from the actor’s working directory', async () => {
        const { one, actor, daemon } = await setup(
          [tool('c1', { path: 'notes/today.txt', text: 'buy bolts' }), says('Done.')],
          { lookup: keeps },
        );
        await one.say(actor.id, 'Keep a note.');
        await one.it.settled(actor.id);
        expect(textOf((await results(actor.id))[0])).toBe('9: buy bolts');
        expect(daemon.asked('write')).toEqual([
          { path: 'notes/today.txt', cwd: '~/work', from: 0, data: base64('buy bolts') },
        ]);
        expect(daemon.asked('read')).toEqual([
          { path: 'notes/today.txt', cwd: '~/work', from: 0, max: 8 << 20 },
        ]);
      });

      it('does so where it turns what an actor is sent into what its model reads', async () => {
        const { one, actor, daemon } = await setup([says('Got it.')], {
          handler: async (payload, _context, _signal, host) => {
            const { text } = payload as { text: string };
            await host.file({
              op: 'write',
              path: 'inbox/a.txt',
              from: 0,
              size: 2,
              data: base64(text),
            });
            return `A file is in inbox/a.txt.`;
          },
        });
        await one.say(actor.id, 'hi');
        await one.it.settled(actor.id);
        expect(daemon.files.get('inbox/a.txt')?.toString()).toBe('hi');
        expect(textOf((await store.conversation(actor.id))[0])).toBe('A file is in inbox/a.txt.');
      });

      it('is told what is wrong: no such file, a file too large for it, a machine that is not connected', async () => {
        const reads: AgentFunction = async (args, _context, _signal, host) => {
          const read = await host.file({
            op: 'read',
            path: (args as { path: string }).path,
            from: 0,
          });
          return String(read?.size);
        };
        const { one, actor, daemon, machines, machine } = await setup(
          [
            tool('c1', { path: 'missing.txt' }),
            tool('c2', { path: 'huge.bin' }),
            says('Oh.'),
            tool('c3', { path: 'missing.txt' }),
            says('Oh.'),
          ],
          { lookup: reads },
        );
        daemon.files.set('huge.bin', Buffer.alloc((32 << 20) + 1));
        daemon.refuse = (_method, params) =>
          params['path'] === 'missing.txt'
            ? { code: 'not_found', message: 'There is no file /home/u/work/missing.txt' }
            : undefined;
        await one.say(actor.id, 'Read.');
        await one.it.settled(actor.id);
        daemon.drop();
        await machines.whenOffline(machine);
        await one.say(actor.id, 'Again.');
        await one.it.settled(actor.id);

        const answered = await results(actor.id);
        expect(answered.map((entry) => (entry.message as { isError?: boolean }).isError)).toEqual([
          true,
          true,
          true,
        ]);
        expect(textOf(answered[0])).toContain('There is no file /home/u/work/missing.txt');
        expect(textOf(answered[1])).toContain(
          "huge.bin is 33554433 bytes: an agent's code reads and writes files of at most 32 MiB",
        );
        expect(textOf(answered[2])).toContain(`The machine ${machine} is not connected`);
      });

      it('is given its actor’s machine: where it is, and the variables its commands are run with, as they are now', async () => {
        const seen: CallContext['machine'][] = [];
        const { one, actor, machine } = await setup(
          [tool('c1'), says('One.'), tool('c2'), says('Two.'), tool('c3'), says('Three.')],
          {
            env: { ORDERS_API_KEY: 'sk-secret-value' },
            lookup: (_args, context) => {
              seen.push(context.machine);
              return 'ok';
            },
          },
        );
        await one.say(actor.id, 'Go.');
        await one.it.settled(actor.id);
        await one.it.setEnv(actor.id, { A: '1', B: '2' });
        await one.say(actor.id, 'Again.');
        await one.it.settled(actor.id);
        await one.it.setEnv(actor.id, {});
        await one.say(actor.id, 'Once more.');
        await one.it.settled(actor.id);
        expect(seen).toEqual([
          { id: machine, cwd: '~/work', env: { ORDERS_API_KEY: 'sk-secret-value' } },
          { id: machine, cwd: '~/work', env: { A: '1', B: '2' } },
          // With none, it is given none: its machine is where it is and no more.
          { id: machine, cwd: '~/work' },
        ]);
      });

      it('has no machine, and no files, for an actor that has none', async () => {
        const seen: CallContext['machine'][] = [];
        const one = engine(
          [tool('c1'), says('Oh.')],
          {},
          {
            lookup: async (_args, context, _signal, host) => {
              seen.push(context.machine);
              await host.file({ op: 'read', path: 'a.txt', from: 0 });
              return 'read';
            },
          },
        );
        const actor = await one.createActor();
        await one.say(actor.id, 'Read.');
        await one.it.settled(actor.id);
        expect(seen).toEqual([null]);
        expect(textOf((await results(actor.id))[0])).toContain('The actor has no machine');
      });

      it('has none where its schema says what an actor may be created with: there is no actor yet', async () => {
        const seen: CallContext['machine'][] = [];
        const one = w.engine([], {
          versions: {
            [ON_MACHINE]: {
              definition: { features: ['machine'], configuration: { schema: null } },
              functions: {
                'configuration.validate': async (given, context, _signal, host) => {
                  seen.push(context.machine);
                  await expect(host.file({ op: 'read', path: 'a', from: 0 })).rejects.toThrow(
                    'The actor has no machine',
                  );
                  return given;
                },
              },
            },
          },
          options: { clock: Date.now, taskTimes: TIMES, secrets, machines: {} },
        });
        engines.push(one);
        await one.deploy(ON_MACHINE);
        const added = await one.it.machines?.add({ name: 'box', agents: '*' });
        const id = added?.machine.id as MachineId;
        const actor = await one.createActor({
          machine: { id, cwd: '~', env: { A: '1' } },
          configuration: { region: 'eu' },
        });
        expect(actor.configuration).toEqual({ region: 'eu' });
        expect(seen).toEqual([null]);
      });
    });

    describe('the variables an actor’s commands are run with', () => {
      it('are given to every command, and kept sealed: their names are answered, never their values', async () => {
        const { one, actor, daemon, ends } = await setup(
          [bash('c1', { command: 'env' }), says('Done.')],
          { env: { ORDERS_API_KEY: 'sk-secret-value', B: '2' } },
        );
        expect(actor.machine).toMatchObject({ cwd: '~/work', env: ['B', 'ORDERS_API_KEY'] });
        ends();
        await one.say(actor.id, 'Go.');
        await one.it.settled(actor.id);
        expect(daemon.asked('run')[0]?.['env']).toEqual({
          ORDERS_API_KEY: 'sk-secret-value',
          B: '2',
        });

        const kept = await store.actorEnv(actor.id);
        expect(kept).toBeTypeOf('string');
        expect(kept).not.toContain('sk-secret-value');
        expect(JSON.stringify(await one.it.getActor(actor.id))).not.toContain('sk-secret-value');
        expect(JSON.stringify(await store.loadCommand(actor.id, 'b1'))).not.toContain('sk-secret');
        expect(JSON.stringify(await one.it.tasks.get(actor.id, 'b1'))).not.toContain('sk-secret');
      });

      it('are replaced whole, at any time, from the next command on', async () => {
        const { one, actor, daemon, ends } = await setup(
          [
            bash('c1', { command: 'sleep 60' }),
            says('One.'),
            bash('c2', { command: 'env' }),
            says('Two.'),
            bash('c3', { command: 'env' }),
            says('Three.'),
          ],
          { env: { A: '1' } },
        );
        await one.say(actor.id, 'Go.');
        await eventually(() => daemon.running.size === 1);
        // In the middle of a turn.
        expect((await one.it.setEnv(actor.id, { B: '2', C: '3' })).machine?.env).toEqual([
          'B',
          'C',
        ]);
        daemon.end({ actor: actor.id, task: 'b1' });
        await one.it.settled(actor.id);
        expect((await one.it.getActor(actor.id)).machine?.env).toEqual(['B', 'C']);

        ends();
        await one.say(actor.id, 'Again.');
        await one.it.settled(actor.id);
        expect(daemon.asked('run').map((params) => params['env'])).toEqual([
          { A: '1' },
          { B: '2', C: '3' },
        ]);

        // None at all.
        expect((await one.it.setEnv(actor.id, {})).machine?.env).toEqual([]);
        expect(await store.actorEnv(actor.id)).toBeNull();
        await one.say(actor.id, 'Once more.');
        await one.it.settled(actor.id);
        expect(daemon.asked('run')[2]).not.toHaveProperty('env');
        // Another engine reads the names as they were last set.
        expect((await store.loadActor(actor.id))?.actor.machine?.env).toEqual([]);
      });

      it('are refused for an actor that has no command to give them to, and by an engine that keeps no secrets', async () => {
        const one = engine([]);
        const plain = await one.createActor();
        await expect(one.it.setEnv(plain.id, { A: '1' })).rejects.toThrow(
          /has no machine, so it runs no command to give variables to/,
        );

        const bare = engine([], { secrets: undefined as never });
        await bare.deploy(ON_MACHINE);
        const added = await bare.it.machines?.add({ name: 'box', agents: '*' });
        const id = added?.machine.id as MachineId;
        await expect(
          bare.createActor({ machine: { id, cwd: '~', env: { A: '1' } } }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        // With no variables there is nothing to seal.
        const actor = await bare.createActor({ machine: { id, cwd: '~' } });
        expect(actor.machine).toEqual({ id, cwd: '~', env: [] });
        await expect(bare.it.setEnv(actor.id, { A: '1' })).rejects.toMatchObject({
          code: 'unavailable',
        });
      });
    });

    describe('whether an actor works on a machine', () => {
      it("is its agent's to say: with `machine: true` it is given one, and otherwise it is given none", async () => {
        const one = engine([]);
        const added = await one.it.machines?.add({ name: 'box', agents: '*' });
        const id = added?.machine.id as MachineId;
        // The agent as first deployed says nothing of a machine.
        await expect(one.createActor({ machine: { id, cwd: '~' } })).rejects.toThrow(
          'An actor of the agent has no machine: its agent does not say machine: true',
        );
        await one.deploy(ON_MACHINE);
        await expect(one.createActor()).rejects.toThrow(
          'An actor of the agent works on a machine: give machine { id, cwd }',
        );
        await expect(one.createActor()).rejects.toMatchObject({ code: 'invalid_request' });
        expect((await one.createActor({ machine: { id, cwd: '~' } })).machine).toEqual({
          id,
          cwd: '~',
          env: [],
        });
        // On the version from before, it is as before.
        expect((await one.createActor({ version: 1 })).machine).toBeNull();
      });

      it('is the machine’s to allow: one that is not for the agent, or is not there, is refused', async () => {
        const one = engine([]);
        const agent = (await one.deploy(ON_MACHINE)).agent.id;
        const added = await one.it.machines?.add({ name: 'box' });
        const id = added?.machine.id as MachineId;
        await expect(one.createActor({ machine: { id, cwd: '~' } })).rejects.toThrow(
          `The machine ${id} is not for the agent ${agent}`,
        );
        await expect(
          one.createActor({
            machine: { id: 'mch_00000000000000000000000000' as MachineId, cwd: '~' },
          }),
        ).rejects.toThrow('There is no machine mch_00000000000000000000000000');
        await one.it.machines?.update(id, { agents: [agent] });
        const actor = await one.createActor({ machine: { id, cwd: '~' } });
        // Actors that are on it stay when it is no longer for their agent.
        await one.it.machines?.update(id, { agents: [] });
        expect((await one.it.getActor(actor.id)).machine?.id).toBe(id);

        // An agent that is deleted is taken off the machines that name it.
        await one.it.machines?.update(id, { agents: [agent] });
        await one.it.deleteAgent(agent);
        expect((await one.it.machines?.get(id))?.agents).toEqual([]);
      });

      it('stays as it was made: a version that says otherwise is not moved to', async () => {
        const one = engine([says('Still here.')]);
        const actor = await one.createActor();
        await one.deploy(ON_MACHINE);
        // It follows its agent, and cannot follow it there.
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 1 },
          behind: {
            deployment: { version: 2 },
            reason:
              'An actor of version 2 of the agent works on a machine: give machine { id, cwd }',
          },
        });
        await expect(one.it.updateActor(actor.id, { version: 2 })).rejects.toMatchObject({
          code: 'conflict',
          message:
            'An actor of version 2 of the agent works on a machine: give machine { id, cwd }',
        });
      });

      it('is not the engine’s to offer when it keeps no machines: such an agent is not deployed', async () => {
        const one = engine([], { machines: undefined as never });
        expect(one.it.machines).toBeUndefined();
        await expect(one.deploy(ON_MACHINE)).rejects.toMatchObject({
          code: 'unsupported_feature',
        });
      });
    });
  });
}
