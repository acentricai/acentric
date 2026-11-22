// What machines do, whatever store they are kept in: the engine's side of a daemon's
// connection, with a daemon of the tests' own (see `fake-daemon.ts`). The daemon itself, the
// program, is run against a real engine where the server is tested.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentId, MachineId } from '@acentric/protocol';

import { IdSource } from '../src/ids.ts';
import {
  CommandNotFound,
  ConnectionLost,
  EnrolRefused,
  InvalidMachine,
  MachineNotFound,
  MachineOffline,
  MachineRefused,
  Machines,
  OWN,
} from '../src/machines.ts';
import type { MachinesOptions } from '../src/machines.ts';
import type { Store } from '../src/store.ts';
import { FakeDaemon } from './fake-daemon.ts';

const NOW = 1_795_305_600_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, for a moment. */
async function until(check: () => boolean | Promise<boolean>, what = 'it'): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error(`${what} did not come to be`);
}

export function machinesSuite(name: string, open: () => Promise<Store>): void {
  describe(`machines: ${name}`, () => {
    let store: Store;
    let now: number;
    let made: Machines[];
    let reported: unknown[];
    let seed = 0;

    const machinesOf = (options: Partial<MachinesOptions> = {}): Machines => {
      const ids = new IdSource(() => {
        seed += 1;
        return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 9, seed >> 8, seed & 255]);
      });
      const machines = new Machines({
        store,
        id: (at) => ids.make('machine', at),
        clock: () => now,
        report: (error) => reported.push(error),
        ...options,
      });
      made.push(machines);
      return machines;
    };

    /** A machine whose daemon has enrolled and is connected. */
    const connected = async (
      machines: Machines,
      name_ = 'box',
    ): Promise<{ id: MachineId; daemon: FakeDaemon }> => {
      const { machine, token } = await machines.add({ name: name_, agents: '*' });
      const daemon = new FakeDaemon();
      await machines.enrol(machine.id, { token, publicKey: daemon.publicKey });
      await daemon.connect(machines, machine.id);
      await machines.whenOnline(machine.id);
      return { id: machine.id, daemon };
    };

    const ref = { actor: 'act_1', task: 'b1' };
    const spec = { ...ref, command: 'echo hi', cwd: '~/work' };

    beforeEach(async () => {
      store = await open();
      now = NOW;
      made = [];
      reported = [];
    });

    afterEach(async () => {
      for (const machines of made) machines.close();
      await store.close();
      expect(reported).toEqual([]);
    });

    describe('a machine', () => {
      it('is added with a token, enrolled by its daemon once, and online when the daemon connects', async () => {
        const machines = machinesOf({ build: () => 'build-1' });
        const added = await machines.add({ name: 'box' });
        expect(added.machine).toMatchObject({
          name: 'box',
          agents: [],
          enrolled: false,
          online: false,
          os: null,
          current: null,
          createdAt: NOW,
          enrolledAt: null,
        });
        expect(added.machine.id).toMatch(/^mch_/);
        expect(added.token).toMatch(/^[0-9a-f]{64}$/);
        expect(added.expiresAt).toBe(NOW + 3_600_000);
        // A daemon that has not enrolled is not taken.
        expect(await machines.accepts(added.machine.id)).toBe(false);

        const daemon = new FakeDaemon();
        now += 1000;
        const enrolled = await machines.enrol(added.machine.id, {
          token: added.token,
          publicKey: daemon.publicKey,
        });
        expect(enrolled).toMatchObject({ enrolled: true, online: false, enrolledAt: NOW + 1000 });
        expect(await machines.accepts(added.machine.id)).toBe(true);

        await daemon.connect(machines, added.machine.id);
        await machines.whenOnline(added.machine.id);
        expect(await machines.get(added.machine.id)).toMatchObject({
          online: true,
          os: 'linux',
          arch: 'x64',
          home: '/home/u',
          hostname: 'box',
          version: '0.1.0',
          current: true,
          lastSeenAt: NOW + 1000,
        });
        expect(machines.facts(added.machine.id)).toMatchObject({ os: 'linux', arch: 'x64' });
        expect(await machines.find('box')).toMatchObject({ id: added.machine.id });
        expect(await machines.find('other')).toBeUndefined();
        expect((await machines.list()).map((one) => one.name)).toEqual(['box']);
      });

      it('is not added with a name that is another machine’s, and is renamed only to one that is free', async () => {
        const machines = machinesOf();
        const first = await machines.add({ name: 'box' });
        await expect(machines.add({ name: 'box' })).rejects.toMatchObject({
          name: 'NameTaken',
          code: 'name_taken',
        });
        const second = await machines.add({ name: 'other' });
        await expect(machines.update(second.machine.id, { name: 'box' })).rejects.toMatchObject({
          name: 'NameTaken',
          code: 'name_taken',
        });
        expect(await machines.update(second.machine.id, { name: 'spare' })).toMatchObject({
          name: 'spare',
        });
        // Its own name is not another's.
        expect(await machines.update(first.machine.id, { name: 'box' })).toMatchObject({
          name: 'box',
        });
      });

      it('is enrolled by its token alone, once, and in time', async () => {
        const machines = machinesOf();
        const { machine, token } = await machines.add({ name: 'box' });
        const daemon = new FakeDaemon();
        const publicKey = daemon.publicKey;
        await expect(machines.enrol(machine.id, { token: 'no', publicKey })).rejects.toBeInstanceOf(
          EnrolRefused,
        );
        await expect(
          machines.enrol('mch_00000000000000000000000000' as MachineId, { token, publicKey }),
        ).rejects.toBeInstanceOf(EnrolRefused);
        await expect(
          machines.enrol(machine.id, { token, publicKey: 'bm90IGEga2V5' }),
        ).rejects.toBeInstanceOf(InvalidMachine);

        // A token that is too old.
        now += 3_600_000;
        await expect(machines.enrol(machine.id, { token, publicKey })).rejects.toBeInstanceOf(
          EnrolRefused,
        );
        const again = await machines.token(machine.id);
        expect(again.token).not.toBe(token);
        await machines.enrol(machine.id, { token: again.token, publicKey });
        // It worked once.
        await expect(
          machines.enrol(machine.id, { token: again.token, publicKey }),
        ).rejects.toBeInstanceOf(EnrolRefused);
        await expect(
          machines.token('mch_00000000000000000000000000' as MachineId),
        ).rejects.toBeInstanceOf(MachineNotFound);
      });

      it('is its newest key alone: a daemon with the key before it is no longer taken', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const first = daemon.link;
        const { token } = await machines.token(id);
        // Until a daemon enrols with the new token, the machine is as it was.
        expect(await machines.get(id)).toMatchObject({ online: true, enrolled: true });

        const next = new FakeDaemon();
        await machines.enrol(id, { token, publicKey: next.publicKey });
        expect(first?.open).toBe(false);
        expect(await machines.get(id)).toMatchObject({ online: false });

        // The old key proves nothing now.
        const refused = await daemon.connect(machines, id);
        expect(refused.closedBy).toEqual({ code: 4401, reason: 'Not this machine' });
        await next.connect(machines, id);
        await machines.whenOnline(id);
      });

      it('takes one connection: the newest, and that of no other machine', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const first = daemon.link;
        await daemon.connect(machines, id);
        await machines.whenOnline(id);
        expect(first?.open).toBe(false);
        expect(await machines.get(id)).toMatchObject({ online: true });

        // A daemon that signs with a key that is not the machine's.
        const impostor = new FakeDaemon();
        impostor.impostor = true;
        const refused = await impostor.connect(machines, id);
        expect(refused.closedBy).toEqual({ code: 4401, reason: 'Not this machine' });
        expect(await machines.get(id)).toMatchObject({ online: true });
      });

      it('is offline when its daemon stops, and online again when it is back', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const since = machines.onlineSince(id);
        expect(since).toBeTypeOf('number');
        now += 5000;
        daemon.drop();
        await machines.whenOffline(id);
        await until(async () => (await machines.get(id)).lastSeenAt === NOW + 5000);
        expect(await machines.get(id)).toMatchObject({ online: false });
        expect(machines.onlineSince(id)).toBeUndefined();
        expect(await machines.online(id, 20)).toBe(false);

        const back = machines.online(id, 2000);
        await daemon.connect(machines, id);
        expect(await back).toBe(true);
      });

      it('is removed with its connection, and its daemon is not taken again', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(() => daemon.running.size === 1);

        await machines.remove(id);
        expect(daemon.link).toBeUndefined();
        expect(await machines.accepts(id)).toBe(false);
        await expect(machines.get(id)).rejects.toBeInstanceOf(MachineNotFound);
        await expect(machines.remove(id)).rejects.toBeInstanceOf(MachineNotFound);
        // What the engine had running there is lost.
        expect(await machines.ended(ref)).toMatchObject({
          status: 'lost',
          error: 'Its machine was removed',
        });
        await expect(machines.start(id, { ...spec, task: 'b2' })).rejects.toBeInstanceOf(
          MachineNotFound,
        );
      });

      it('is for the agents it is said to be for, and for none until it is said', async () => {
        const machines = machinesOf();
        const { machine } = await machines.add({ name: 'box' });
        const one = 'agt_00000000000000000000000001' as AgentId;
        const other = 'agt_00000000000000000000000002' as AgentId;
        expect(await machines.refuses(machine.id, one)).toMatch(/is not for the agent/);
        expect(await machines.update(machine.id, { agents: [one, one] })).toMatchObject({
          agents: [one],
        });
        expect(await machines.refuses(machine.id, one)).toBeUndefined();
        expect(await machines.refuses(machine.id, other)).toMatch(/is not for the agent/);
        await machines.update(machine.id, { agents: '*' });
        expect(await machines.refuses(machine.id, other)).toBeUndefined();
        expect(await machines.refuses('mch_00000000000000000000000000' as MachineId, one)).toMatch(
          /There is no machine/,
        );
      });

      it('is given up when its daemon does not prove itself, says nothing, or does not answer', async () => {
        const machines = machinesOf({ times: { proofMs: 30, silenceMs: 60, requestMs: 40 } });
        const { id, daemon } = await connected(machines);

        const mute = new FakeDaemon();
        mute.mute = true;
        const unproved = await mute.connect(machines, id);
        expect(unproved.closedBy).toEqual({ code: 4401, reason: 'No proof' });
        // The machine's own connection is as it was.
        expect(await machines.get(id)).toMatchObject({ online: true });

        // It asks for something, and is not answered.
        daemon.silent = true;
        await expect(machines.read(id, { path: '/etc/hostname' })).rejects.toBeInstanceOf(
          ConnectionLost,
        );
        await machines.whenOffline(id);

        // It says nothing at all for too long.
        daemon.silent = false;
        await daemon.connect(machines, id);
        await machines.whenOnline(id);
        await machines.whenOffline(id);
        expect(daemon.link).toBeUndefined();
      });
    });

    describe('a command', () => {
      it('is stored, run on the machine, and ends with its exit status and what it wrote', async () => {
        const machines = machinesOf({ envOf: async () => ({ TOKEN: 'secret' }) });
        const { id, daemon } = await connected(machines);
        const started = await machines.start(id, { ...spec, timeout: 30 });
        expect(started).toMatchObject({
          ...ref,
          machine: id,
          command: 'echo hi',
          cwd: '~/work',
          timeout: 30,
          status: 'starting',
          startedAt: NOW,
        });
        await until(async () => (await machines.command(ref))?.status === 'running');
        expect(daemon.asked('run')).toEqual([
          { ...ref, command: 'echo hi', cwd: '~/work', timeout: 30, env: { TOKEN: 'secret' } },
        ]);
        expect(await machines.command(ref)).toMatchObject({
          log: '/home/u/.acentric-machine/tasks/act_1/b1/output.log',
        });
        expect(machines.logOf(id, ref)).toBe('~/.acentric-machine/tasks/act_1/b1/output.log');

        const ended = machines.ended(ref);
        now += 2000;
        daemon.end(ref, { exit: 3, ranMs: 1999.6, bytes: 3, lines: 1, tail: 'hi\n' });
        expect(await ended).toMatchObject({
          status: 'exited',
          exit: 3,
          stoppedBy: null,
          ranMs: 2000,
          bytes: 3,
          lines: 1,
          tail: 'hi\n',
          error: null,
          endedAt: NOW + 2000,
        });
        // The machine was told that the ending arrived, after it was stored.
        await until(() => daemon.unacked.size === 0);
        expect(daemon.acks).toEqual(['act_1/b1']);
      });

      it('runs once, however many times it is asked for', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const [one, two] = await Promise.all([machines.start(id, spec), machines.start(id, spec)]);
        expect(two).toMatchObject({ ...ref, startedAt: one.startedAt });
        await until(async () => (await machines.command(ref))?.status === 'running');
        await machines.start(id, spec);
        expect(daemon.asked('run')).toHaveLength(1);

        // Its variables are sent with no value where it has none.
        expect(daemon.asked('run')[0]).not.toHaveProperty('env');
        expect(daemon.asked('run')[0]).not.toHaveProperty('timeout');
      });

      it('is refused for a machine that is not connected, and nothing of it is kept', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        daemon.drop();
        await machines.whenOffline(id);
        await expect(machines.start(id, spec)).rejects.toBeInstanceOf(MachineOffline);
        expect(await machines.command(ref)).toBeUndefined();
        await expect(machines.ended(ref)).rejects.toBeInstanceOf(CommandNotFound);
        await expect(machines.stop(ref)).rejects.toBeInstanceOf(CommandNotFound);
        await expect(machines.start(id, { ...spec, actor: 'not a name' })).rejects.toBeInstanceOf(
          InvalidMachine,
        );
      });

      it('is not started without its variables', async () => {
        const machines = machinesOf({
          envOf: async () => {
            throw new Error('sealed with another key');
          },
        });
        const { id, daemon } = await connected(machines);
        await expect(machines.start(id, spec)).rejects.toThrow('sealed with another key');
        expect(await machines.command(ref)).toBeUndefined();
        expect(daemon.asked('run')).toEqual([]);
      });

      it('fails when the machine says it cannot be started', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        daemon.refuse = (method) =>
          method === 'run'
            ? { code: 'bad_cwd', message: 'There is no directory ~/work' }
            : undefined;
        await machines.start(id, spec);
        expect(await machines.ended(ref)).toMatchObject({
          status: 'failed',
          error: 'There is no directory ~/work',
          endedAt: NOW,
        });
      });

      it('is stopped when that is asked for, and the stop is asked of the machine', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(() => daemon.running.size === 1);
        await machines.stop(ref);
        expect(await machines.ended(ref)).toMatchObject({
          status: 'stopped',
          stoppedBy: 'stop',
          exit: null,
          tail: 'so far\n',
        });
        expect(daemon.asked('stop')).toEqual([ref]);
        // One that has ended is not stopped again.
        await machines.stop(ref);
        expect(daemon.asked('stop')).toHaveLength(1);
      });

      it('lets go of whoever waits for it when they no longer do, or the engine goes away', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        const waiting = new AbortController();
        const first = machines.ended(ref, waiting.signal);
        waiting.abort();
        expect(await first).toBeUndefined();
        const second = machines.run(id, spec);
        await until(() => daemon.running.size === 1);
        machines.close();
        expect(await second).toBeUndefined();
        // The command is as it was.
        expect(await store.loadCommand(ref.actor, ref.task)).toMatchObject({ status: 'running' });
      });

      it('of the machine’s own is for no actor, and is named by the engine', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const other = await connected(machines, 'other');
        const [one, two] = await Promise.all([
          machines.startOwn(id, { command: 'uptime', cwd: '~' }),
          machines.startOwn(other.id, { command: 'df', cwd: '/', timeout: 5 }),
        ]);
        const three = await machines.startOwn(id, { command: 'date', cwd: '~' });
        expect([one.task, two.task, three.task].toSorted()).toEqual(['c1', 'c2', 'c3']);
        expect(one).toMatchObject({ actor: OWN, machine: id, timeout: null });
        expect(two).toMatchObject({ machine: other.id, timeout: 5 });
        await until(() => daemon.asked('run').length === 2);

        expect(await machines.own(id, one.task)).toMatchObject({ command: 'uptime' });
        // Not one of the other machine's, and no actor's.
        await expect(machines.own(other.id, one.task)).rejects.toBeInstanceOf(CommandNotFound);
        await machines.start(id, spec);
        await expect(machines.own(id, 'b1')).rejects.toBeInstanceOf(CommandNotFound);
        expect((await machines.owns(id, 10)).map((command) => command.task)).toEqual([
          three.task,
          one.task,
        ]);
        expect(await machines.owns(id, 1)).toHaveLength(1);
        await expect(
          machines.owns('mch_00000000000000000000000000' as MachineId, 1),
        ).rejects.toBeInstanceOf(MachineNotFound);
      });
    });

    describe('a connection that is lost', () => {
      it('stops nothing: a command ends without it, and its ending arrives when the daemon is back', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(async () => (await machines.command(ref))?.status === 'running');
        daemon.drop();
        await machines.whenOffline(id);
        daemon.end(ref, { exit: 0, tail: 'done\n' });
        expect(await machines.command(ref)).toMatchObject({ status: 'running' });

        const ended = machines.ended(ref);
        await daemon.connect(machines, id);
        expect(await ended).toMatchObject({ status: 'exited', exit: 0, tail: 'done\n' });
        await until(() => daemon.unacked.size === 0);
        // It was not asked for again.
        expect(daemon.asked('run')).toHaveLength(1);
      });

      it('keeps a stop that was asked for meanwhile, and the machine does it when it is back', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(async () => (await machines.command(ref))?.status === 'running');
        daemon.drop();
        await machines.whenOffline(id);
        await machines.stop(ref);
        expect(daemon.asked('stop')).toEqual([]);

        await daemon.connect(machines, id);
        expect(await machines.ended(ref)).toMatchObject({ status: 'stopped', stoppedBy: 'stop' });
        expect(daemon.asked('stop')).toEqual([ref]);
      });

      it('is put right when the machine never got a command: the engine asks again', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        // The request is sent, and the connection goes before it is answered.
        daemon.silent = true;
        await machines.start(id, spec);
        await until(() => daemon.asked('run').length === 1);
        daemon.drop();
        await machines.whenOffline(id);
        expect(await machines.command(ref)).toMatchObject({ status: 'starting' });

        // A machine that never had it says so by not naming it.
        daemon.silent = false;
        await daemon.connect(machines, id);
        await until(async () => (await machines.command(ref))?.status === 'running');
        expect(daemon.asked('run')).toHaveLength(2);
      });

      it('is put right when the machine got a command and its answer was lost', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        daemon.silent = true;
        await machines.start(id, spec);
        await until(() => daemon.asked('run').length === 1);
        daemon.drop();
        await machines.whenOffline(id);

        // It has it: it says so when it is back, and is not asked again.
        daemon.silent = false;
        daemon.running.set('act_1/b1', { ...ref, log: '/var/log/b1' });
        await daemon.connect(machines, id);
        await until(async () => (await machines.command(ref))?.status === 'running');
        expect(await machines.command(ref)).toMatchObject({ log: '/var/log/b1' });
        expect(daemon.asked('run')).toHaveLength(1);
      });

      it('is put right when a stop was asked for before the machine ever had the command', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        daemon.silent = true;
        await machines.start(id, spec);
        await until(() => daemon.asked('run').length === 1);
        daemon.drop();
        await machines.whenOffline(id);
        await machines.stop(ref);

        daemon.silent = false;
        now += 700;
        await daemon.connect(machines, id);
        expect(await machines.ended(ref)).toMatchObject({
          status: 'stopped',
          stoppedBy: 'stop',
          ranMs: 0,
          tail: '',
          endedAt: NOW + 700,
        });
        // It is neither run nor stopped there: it never was there.
        expect(daemon.asked('run')).toHaveLength(1);
        expect(daemon.asked('stop')).toEqual([]);
      });

      it('finds a command its machine no longer has, which is lost', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(async () => (await machines.command(ref))?.status === 'running');
        daemon.drop();
        await machines.whenOffline(id);
        // The machine restarted, and has nothing of it.
        daemon.running.clear();
        await daemon.connect(machines, id);
        expect(await machines.ended(ref)).toMatchObject({
          status: 'lost',
          error: 'Its machine no longer has it: the machine restarted, or its folder was removed',
        });
      });

      it('takes the machine’s word that a command is gone and left nothing', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        await machines.start(id, spec);
        await until(() => daemon.running.size === 1);
        daemon.end(ref, { status: 'lost', exit: null, tail: 'half' });
        expect(await machines.ended(ref)).toMatchObject({
          status: 'lost',
          tail: 'half',
          error:
            'It is gone and left no exit status: its machine restarted, or it was killed from outside',
        });
      });

      it('lets the machine forget an ending the engine has no command for, or has already', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        daemon.end({ actor: 'act_9', task: 'b7' });
        await until(() => daemon.acks.includes('act_9/b7'));
        expect(await machines.command({ actor: 'act_9', task: 'b7' })).toBeUndefined();

        await machines.start(id, spec);
        await until(() => daemon.running.size === 1);
        daemon.end(ref, { exit: 0 });
        await machines.ended(ref);
        // Sent again, as after an acknowledgement that was lost: what is stored stays.
        daemon.end(ref, { exit: 9 });
        await until(() => daemon.acks.filter((ack) => ack === 'act_1/b1').length === 2);
        expect(await machines.command(ref)).toMatchObject({ status: 'exited', exit: 0 });
      });

      it('is opened again by the daemon when another engine starts on the same store', async () => {
        const first = machinesOf();
        const { id, daemon } = await connected(first);
        await first.start(id, spec);
        await until(async () => (await first.command(ref))?.status === 'running');
        first.close();
        expect(daemon.link).toBeUndefined();

        const second = machinesOf({ times: { returnMs: 2000 } });
        await second.load();
        // Known before its daemon has found this engine: where a command's output is.
        expect(second.logOf(id, ref)).toBe('~/.acentric-machine/tasks/act_1/b1/output.log');
        // It is waited for a moment: it was connected to the engine before this one.
        let settled = false;
        const waited = second.settled(id).then(() => {
          settled = true;
        });
        await sleep(30);
        expect(settled).toBe(false);
        await daemon.connect(second, id);
        await waited;
        // One that never enrolled is not waited for.
        const { machine } = await second.add({ name: 'new' });
        await second.settled(machine.id);

        daemon.end(ref, { exit: 0 });
        expect(await second.ended(ref)).toMatchObject({ status: 'exited' });
      });
    });

    describe('a file on a machine', () => {
      it('is read and written through its daemon, and refused as the daemon refuses it', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        expect(
          await machines.write(id, {
            path: '/tmp/a',
            data: Buffer.from('hello').toString('base64'),
          }),
        ).toEqual({ path: '/tmp/a', size: 5 });
        const read = await machines.read(id, { path: '/tmp/a', from: 1, max: 3 });
        expect(Buffer.from(read.data, 'base64').toString()).toBe('ell');
        expect(read).toMatchObject({ size: 5, from: 1 });

        daemon.refuse = () => ({ code: 'not_found', message: 'There is no file /tmp/b' });
        const refused = await machines
          .read(id, { path: '/tmp/b' })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(MachineRefused);
        expect(refused).toMatchObject({ reason: 'not_found', message: 'There is no file /tmp/b' });

        daemon.drop();
        await machines.whenOffline(id);
        await expect(machines.read(id, { path: '/tmp/a' })).rejects.toBeInstanceOf(MachineOffline);
        await expect(
          machines.read('mch_00000000000000000000000000' as MachineId, { path: '/tmp/a' }),
        ).rejects.toBeInstanceOf(MachineNotFound);
      });

      it('is moved whole for an agent’s code, in as many requests as it takes', async () => {
        const machines = machinesOf();
        const { id, daemon } = await connected(machines);
        const bytes = Buffer.alloc((8 << 20) + 1000, 7);
        bytes[bytes.length - 1] = 9;
        await machines.file(
          { id, cwd: '~/work' },
          { op: 'write', path: 'big.bin', data: bytes.toString('base64') },
        );
        expect(daemon.asked('write').map(({ from, cwd }) => [from, cwd])).toEqual([
          [0, '~/work'],
          [8 << 20, '~/work'],
        ]);
        const read = await machines.file({ id, cwd: '~/work' }, { op: 'read', path: 'big.bin' });
        expect(Buffer.from(read ?? '', 'base64').equals(bytes)).toBe(true);
        expect(daemon.asked('read')).toHaveLength(2);

        // An empty file is one request, and is written as empty.
        await machines.file({ id, cwd: '~' }, { op: 'write', path: 'empty', data: '' });
        expect(daemon.files.get('empty')?.length).toBe(0);
        expect(await machines.file({ id, cwd: '~' }, { op: 'read', path: 'empty' })).toBe('');

        const tooLarge = Buffer.alloc((32 << 20) + 1).toString('base64');
        await expect(
          machines.file({ id, cwd: '~' }, { op: 'write', path: 'huge', data: tooLarge }),
        ).rejects.toThrow(/at most 32 MiB/);
      });
    });

    describe('a daemon’s program', () => {
      it('is replaced by the build the engine hands out, when it is another', async () => {
        const machines = machinesOf({
          build: (os, arch) => (os === 'linux' && arch === 'x64' ? 'build-2' : undefined),
          times: { returnMs: 2000 },
        });
        const { id, daemon } = await connected(machines);
        expect(await machines.get(id)).toMatchObject({ current: false });
        daemon.onUpdate = (digest) => {
          // It takes the program, answers, and starts again as it.
          setTimeout(() => {
            daemon.facts.build = digest;
            daemon.drop();
            setTimeout(() => void daemon.connect(machines, id), 10);
          }, 5);
          return { updated: true, build: digest };
        };
        expect(await machines.upgrade(id)).toMatchObject({
          updated: true,
          machine: { online: true, current: true },
        });
        expect(daemon.asked('update')).toEqual([{ digest: 'build-2' }]);

        // It is that build now: nothing is asked of it.
        expect(await machines.upgrade(id)).toMatchObject({ updated: false });
        expect(daemon.asked('update')).toHaveLength(1);
      });

      it('is not replaced when the engine hands out none for its system, or it is not connected', async () => {
        const machines = machinesOf({ build: () => undefined });
        const { id, daemon } = await connected(machines);
        expect(await machines.get(id)).toMatchObject({ current: null });
        await expect(machines.upgrade(id)).rejects.toThrow(
          'This engine hands out no machine program for linux-x64',
        );
        daemon.drop();
        await machines.whenOffline(id);
        await expect(machines.upgrade(id)).rejects.toBeInstanceOf(MachineOffline);
        await expect(
          machines.upgrade('mch_00000000000000000000000000' as MachineId),
        ).rejects.toBeInstanceOf(MachineNotFound);
      });

      it('says so when it is too old to replace itself', async () => {
        const machines = machinesOf({ build: () => 'build-2' });
        const { id, daemon } = await connected(machines);
        daemon.refuse = () => ({ code: 'invalid', message: 'There is no such method' });
        await expect(machines.upgrade(id)).rejects.toThrow(/too old to update itself/);
      });
    });
  });
}
