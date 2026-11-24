// What sandboxes do, whatever store they are kept in: the engine's side of a provider, with a
// provider of the tests' own (see `fake-provider.ts`) whose sandboxes are daemons of the
// tests' own. The providers themselves are tested where they are written.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import type { MachineId, SandboxProviderId } from '@acentric/protocol';

import { Conflict } from '../src/errors.ts';
import { IdSource } from '../src/ids.ts';
import { MachineNotFound, Machines } from '../src/machines.ts';
import { LABEL_MACHINE, LABEL_PROVIDER, ProviderFailed } from '../src/sandbox.ts';
import {
  InvalidSandbox,
  NotASandbox,
  ProviderNotFound,
  SandboxAsleep,
  Sandboxes,
  SandboxesUnavailable,
} from '../src/sandboxes.ts';
import type { SandboxTimes, SandboxesOptions } from '../src/sandboxes.ts';
import { Secrets, SecretsUnavailable } from '../src/secrets.ts';
import type { Store } from '../src/store.ts';
import type { AgentFunction } from '../src/testing.ts';
import { FakeProvider } from './fake-provider.ts';
import { world } from './world.ts';

const NOW = 1_795_305_600_000;
const HOUR = 3_600_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ORIGIN = 'https://engine.example';

/** Short waits, and a look at what is due only when a test asks for one. */
const TIMES: Partial<SandboxTimes> = {
  waitMs: 2000,
  wakeMs: 400,
  stoppingMs: 10,
  tickMs: 3_600_000,
};

export function sandboxesSuite(name: string, open: () => Promise<Store>): void {
  describe(`sandboxes: ${name}`, () => {
    let store: Store;
    let now: number;
    let closing: { close(): void }[];
    let reported: unknown[];
    let seed = 0;

    const secretsOf = (): Secrets =>
      new Secrets({ store, keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } } });

    /** Machines, sandboxes over them, and a provider whose sandboxes' daemons connect to them. */
    const setup = (
      given: {
        readonly provider?: FakeProvider;
        readonly options?: Partial<SandboxesOptions>;
        readonly secrets?: Secrets | null;
      } = {},
    ) => {
      const ids = new IdSource(() => {
        seed += 1;
        return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 7, seed >> 8, seed & 255]);
      });
      const machines = new Machines({
        store,
        id: (at) => ids.make('machine', at),
        clock: () => now,
        report: (error) => reported.push(error),
      });
      const provider = given.provider ?? new FakeProvider();
      provider.machines = machines;
      const secrets = given.secrets === null ? undefined : (given.secrets ?? secretsOf());
      const sandboxes = new Sandboxes({
        store,
        machines,
        providers: [provider],
        id: (at) => ids.make('sandboxProvider', at),
        clock: () => now,
        report: (error) => reported.push(error),
        times: TIMES,
        ...(secrets === undefined ? {} : { secrets }),
        ...given.options,
      });
      closing.push(sandboxes, machines);
      return { machines, sandboxes, provider };
    };

    /** The same, with an account added, and a way to make a sandbox in it. */
    const withAccount = async (given: Parameters<typeof setup>[0] = {}) => {
      const made = setup(given);
      const { provider, sandboxes } = made;
      const account = await sandboxes.addProvider({
        kind: provider.kind,
        name: 'main',
        ...(provider.credential === 'api_key' ? { apiKey: 'good-key' } : {}),
      });
      const create = (more: Partial<Parameters<Sandboxes['create']>[0]> = {}) =>
        sandboxes.create(
          { provider: account.id, vcpu: 2, memoryGB: 4, agents: '*', ...more },
          ORIGIN,
        );
      return { ...made, account, create };
    };

    const deadlineOf = async (id: MachineId) => (await store.loadMachine(id))?.sandbox?.deadline;

    beforeEach(async () => {
      store = await open();
      now = NOW;
      closing = [];
      reported = [];
    });

    afterEach(async () => {
      for (const one of closing) one.close();
      await store.close();
      expect(reported).toEqual([]);
    });

    describe('an account at a provider', () => {
      it('is added by its key, which the provider is asked about first, and is kept sealed and never given back', async () => {
        const { sandboxes, provider } = setup();
        const added = await sandboxes.addProvider({
          kind: 'fake',
          name: 'main',
          apiKey: '  good-key ',
        });
        expect(added).toEqual({
          id: expect.stringMatching(/^prv_/) as string,
          kind: 'fake',
          name: 'main',
          account: 'dev@example.com',
          sandboxes: 0,
          createdAt: NOW,
        });
        expect(provider.calls).toEqual(['whoami']);
        expect(await sandboxes.providers()).toEqual([added]);
        const kept = await store.loadSandboxProvider(added.id);
        expect(kept?.credential).toBeTypeOf('string');
        expect(JSON.stringify(kept)).not.toContain('good-key');
        expect(JSON.stringify(await sandboxes.providers())).not.toContain('good-key');
      });

      it('is not kept when the provider refuses its key, or when it is not what the provider takes', async () => {
        const { sandboxes, provider } = setup();
        const refused = await sandboxes
          .addProvider({ kind: 'fake', name: 'main', apiKey: 'bad-key' })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ProviderFailed);
        expect(refused).toMatchObject({
          reason: 'credential',
          message: "Fake refused the account's credential: add the account again with a new one",
        });
        expect(await sandboxes.providers()).toEqual([]);

        provider.calls.length = 0;
        await expect(sandboxes.addProvider({ kind: 'fake', name: 'main' })).rejects.toThrow(
          '`apiKey` is the Fake API key of the account',
        );
        await expect(
          sandboxes.addProvider({ kind: 'fake', name: 'main', apiKey: 'two words' }),
        ).rejects.toBeInstanceOf(InvalidSandbox);
        await expect(
          sandboxes.addProvider({ kind: 'other', name: 'main', apiKey: 'good-key' }),
        ).rejects.toThrow('`kind` is a provider this server was set up with: fake');
        await sandboxes.addProvider({ kind: 'fake', name: 'main', apiKey: 'good-key' });
        provider.calls.length = 0;
        // A name that is another's is refused before the provider is asked.
        await expect(
          sandboxes.addProvider({ kind: 'fake', name: 'main', apiKey: 'good-key' }),
        ).rejects.toMatchObject({ name: 'NameTaken', code: 'name_taken' });
        expect(provider.calls).toEqual([]);
      });

      it('is taken with a key only by an engine that keeps secrets, and without one by any', async () => {
        const keyed = setup({ secrets: null });
        await expect(
          keyed.sandboxes.addProvider({ kind: 'fake', name: 'main', apiKey: 'good-key' }),
        ).rejects.toBeInstanceOf(SecretsUnavailable);
        // Nothing was asked of the provider with a key that would not have been kept.
        expect(keyed.provider.calls).toEqual([]);

        const local = new FakeProvider({ kind: 'local', label: 'Local', credential: 'none' });
        const { sandboxes } = setup({ provider: local, secrets: null });
        await expect(
          sandboxes.addProvider({ kind: 'local', name: 'here', apiKey: 'good-key' }),
        ).rejects.toThrow('An account at Local has no API key');
        const added = await sandboxes.addProvider({ kind: 'local', name: 'here' });
        expect(added).toMatchObject({ kind: 'local', account: null });
        expect((await store.loadSandboxProvider(added.id))?.credential).toBeNull();
      });

      it('is forgotten when asked, and not while it has sandboxes', async () => {
        const { sandboxes, account, create } = await withAccount();
        const made = await create();
        expect((await sandboxes.providers())[0]?.sandboxes).toBe(1);
        const refused = await sandboxes.removeProvider(account.id).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Conflict);
        expect(refused).toMatchObject({ message: "Remove this account's sandboxes first" });
        await sandboxes.remove(made.machine.id);
        await sandboxes.removeProvider(account.id);
        expect(await sandboxes.providers()).toEqual([]);
        await expect(sandboxes.removeProvider(account.id)).rejects.toBeInstanceOf(ProviderNotFound);
      });
    });

    describe('a sandbox', () => {
      it('is made at the provider with what its daemon enrols with, and is a machine once made', async () => {
        const { machines, provider, account, create } = await withAccount();
        const made = await create({ name: 'builder' });
        expect(made).toMatchObject({
          provider: account.id,
          kind: 'fake',
          providerSandboxId: 'sbx-1',
          vcpu: 2,
          memoryGB: 4,
          idleTimeoutSeconds: 3600,
          state: 'running',
          machine: { name: 'builder', agents: '*', enrolled: true, online: true },
        });
        const { id } = made.machine;
        const { asked } = provider.only;
        expect(asked).toMatchObject({
          machine: id,
          name: 'builder',
          vcpu: 2,
          memoryGB: 4,
          idleSeconds: 3600,
          labels: { [LABEL_MACHINE]: id, [LABEL_PROVIDER]: account.id },
        });
        expect(JSON.parse(asked.provision)).toEqual({
          server: ORIGIN,
          id,
          token: expect.any(String) as string,
        });
        // It is a machine like any other, that says whose account it was made in.
        expect(await machines.get(id)).toMatchObject({ provider: account.id, online: true });
        expect((await machines.list()).map((one) => one.provider)).toEqual([account.id]);
        // Its idle time runs from when the provider was asked.
        expect(await deadlineOf(id)).toBe(NOW + HOUR);
      });

      it('is made with the idle time asked for, a name of its own, and where its daemon reaches the engine', async () => {
        const provider = new FakeProvider();
        provider.serverFor = (url) => url.replace('public.example', 'inside.example');
        const { create } = await withAccount({
          provider,
          options: { publicUrl: 'https://public.example' },
        });
        const made = await create({ idleTimeoutSeconds: 120, vcpu: 8, memoryGB: 16 });
        expect(made).toMatchObject({ idleTimeoutSeconds: 120, vcpu: 8, memoryGB: 16 });
        expect(made.machine.name).toMatch(/^sandbox-[0-9a-f]{8}$/);
        expect(made.machine.agents).toBe('*');
        expect(provider.only.asked.idleSeconds).toBe(120);
        // Where it was told it is reached, not where the request came to, as the provider's sandboxes reach that.
        expect(JSON.parse(provider.only.asked.provision)).toMatchObject({
          server: 'https://inside.example',
        });
      });

      it('answers after the wait when its daemon has not connected yet, and shows online when it has', async () => {
        const { machines, provider, create } = await withAccount();
        provider.boots = false;
        const made = await create({ wait: 0 });
        expect(made).toMatchObject({ state: 'starting', machine: { online: false } });
        await provider.boot('sbx-1');
        await machines.whenOnline(made.machine.id);
        expect((await machines.get(made.machine.id)).online).toBe(true);
      });

      it('is refused for what the provider does not make, before the provider is asked', async () => {
        const { sandboxes, machines, provider, account, create } = await withAccount();
        provider.calls.length = 0;
        await expect(create({ vcpu: 3, memoryGB: 4 })).rejects.toThrow(
          'Fake has no 3 vCPU / 4 GB size',
        );
        await expect(create({ idleTimeoutSeconds: 59 })).rejects.toThrow(
          '`idleTimeoutSeconds` is a whole number from 60 to 2592000',
        );
        await expect(create({ wait: 121 })).rejects.toBeInstanceOf(InvalidSandbox);
        const nowhere = 'prv_00000000000000000000000000' as SandboxProviderId;
        await expect(create({ provider: nowhere })).rejects.toBeInstanceOf(ProviderNotFound);
        provider.missing = 'Sandboxes at Fake are not set up on this server';
        const unavailable = await create().catch((error: unknown) => error);
        expect(unavailable).toBeInstanceOf(SandboxesUnavailable);
        expect(unavailable).toMatchObject({ code: 'unavailable', message: provider.missing });
        expect(provider.calls).toEqual([]);
        expect(await machines.list()).toEqual([]);
        expect((await sandboxes.providers())[0]).toMatchObject({ id: account.id, sandboxes: 0 });
      });

      it('leaves no machine behind when the provider does not make it, and says why as the provider did', async () => {
        const { machines, provider, create } = await withAccount();
        provider.fail = (call) =>
          call === 'create' ? new ProviderFailed('Fake answered 402: out of credit') : undefined;
        await expect(create({ name: 'builder' })).rejects.toThrow(
          'Fake answered 402: out of credit',
        );
        expect(await machines.list()).toEqual([]);
        // Its name is free for the next one.
        provider.fail = () => undefined;
        expect((await create({ name: 'builder' })).machine.name).toBe('builder');
      });
    });

    describe('a sandbox that has gone to sleep', () => {
      it('is started again for what needs it, which waits for its daemon', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const { id } = (await create({ idleTimeoutSeconds: 600 })).machine;
        provider.expire('sbx-1');
        await machines.whenOffline(id);
        provider.calls.length = 0;
        now += HOUR;
        await sandboxes.wake(id);
        expect(provider.calls).toEqual(['state sbx-1', 'start sbx-1 600']);
        expect((await machines.get(id)).online).toBe(true);
        // Its idle time runs again from the start this made.
        expect(await deadlineOf(id)).toBe(now + 600_000);
      });

      it('is asked nothing about while it is connected and its idle time is far from running out', async () => {
        const { sandboxes, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.calls.length = 0;
        now += HOUR - 61_000;
        await sandboxes.wake(id);
        expect(provider.calls).toEqual([]);
        // Nor is a machine that is no sandbox, or is none at all.
        const { machines } = setup();
        const { machine } = await machines.add({ name: 'laptop' });
        await sandboxes.wake(machine.id);
        await sandboxes.wake('mch_00000000000000000000000000' as MachineId);
        expect(provider.calls).toEqual([]);
      });

      it('has its idle time put off before a command when it is about to run out', async () => {
        const { sandboxes, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.calls.length = 0;
        now += HOUR - 59_000;
        await sandboxes.wake(id);
        expect(provider.calls).toEqual(['state sbx-1', 'keepFor sbx-1 3600']);
        expect(await deadlineOf(id)).toBe(now + HOUR);
      });

      it('is started once for two that need it at once', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.expire('sbx-1');
        await machines.whenOffline(id);
        provider.calls.length = 0;
        await Promise.all([sandboxes.wake(id), sandboxes.wake(id), sandboxes.wake(id)]);
        expect(provider.asked('start')).toEqual(['sbx-1 3600']);
      });

      it('is tried again while its provider is still stopping it', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.expire('sbx-1');
        provider.only.state = 'stopping';
        await machines.whenOffline(id);
        provider.calls.length = 0;
        provider.wait = async (call) => {
          // Stopped by the time it is asked a third time.
          if (call === 'start' && provider.asked('start').length === 3) {
            provider.only.state = 'stopped';
          }
        };
        await sandboxes.wake(id);
        expect(provider.asked('start')).toHaveLength(3);
        expect((await machines.get(id)).online).toBe(true);
      });

      it('rejects with why when it cannot be had: gone, not to be asked about, or never back', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const made = (await create({ name: 'builder' })).machine;
        const { id } = made;
        provider.expire('sbx-1');
        await machines.whenOffline(id);

        provider.boots = false;
        const never = await sandboxes.wake(id).catch((error: unknown) => error);
        expect(never).toBeInstanceOf(SandboxAsleep);
        expect(never).toMatchObject({
          code: 'sandbox_asleep',
          message:
            'Your machine, builder, is a sandbox that is still starting up: nothing was run. Try again shortly.',
        });

        provider.only.state = 'stopped';
        provider.fail = (call) =>
          call === 'start' ? new ProviderFailed('Fake answered 500: no room') : undefined;
        await expect(sandboxes.wake(id)).rejects.toThrow(
          'Your machine, builder, is a sandbox that could not be started: Fake answered 500: no room. Nothing was run.',
        );

        provider.fail = (call) =>
          call === 'state' ? new ProviderFailed('Fake could not be reached') : undefined;
        await expect(sandboxes.wake(id)).rejects.toThrow(
          'Your machine, builder, is a sandbox, and its provider could not be asked about it: Fake could not be reached. Nothing was run.',
        );

        provider.fail = () => undefined;
        provider.sandboxes.clear();
        await expect(sandboxes.wake(id)).rejects.toThrow(
          'Your machine, builder, was a sandbox, and it no longer exists: nothing was run.',
        );
      });

      it('is found again by the next engine, which starts it as this one would', async () => {
        const first = await withAccount();
        const { id } = (await first.create()).machine;
        first.provider.expire('sbx-1');
        await first.machines.whenOffline(id);
        first.sandboxes.close();
        first.machines.close();

        const next = setup({ provider: first.provider });
        first.provider.calls.length = 0;
        await next.sandboxes.wake(id);
        expect(first.provider.calls).toEqual(['state sbx-1', 'start sbx-1 3600']);
        expect((await next.machines.get(id)).online).toBe(true);
      });
    });

    describe('the idle time of a sandbox its provider stops', () => {
      const ref = { actor: 'act_1', task: 'b1' };

      it('is put off when a command starts, while one runs, and once more when the last has ended', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const { id } = (await create({ idleTimeoutSeconds: 600 })).machine;
        provider.calls.length = 0;

        // Nothing was run on it: it is left to sleep.
        now += 100_000;
        await sandboxes.keepAwake();
        expect(provider.calls).toEqual([]);

        // A command starts: soon, and not at every command.
        await sandboxes.wake(id);
        await sandboxes.wake(id);
        await machines.start(id, { ...ref, command: 'sleep 900', cwd: '~' });
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toEqual(['sbx-1 600']);
        expect(await deadlineOf(id)).toBe(now + 600_000);

        // While it runs: every half of the idle time, and not before.
        now += 299_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(1);
        now += 1_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(2);

        // The last one ends: once more, and then no more.
        provider.only.daemon.end(ref);
        await expect.poll(() => machines.busy(id)).toBe(0);
        now += 5_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(3);
        expect(await deadlineOf(id)).toBe(now + 600_000);
        now += 600_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(3);
        // It is its provider's to stop: the engine asks for no stop.
        expect(provider.asked('stop')).toEqual([]);
      });

      it('is tried again a while after the provider could not be asked, and forgotten for a sandbox it no longer has', async () => {
        const { sandboxes, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.calls.length = 0;
        now += 100_000;
        await sandboxes.wake(id);
        provider.fail = (call) =>
          call === 'keepFor' ? new ProviderFailed('Fake answered 500') : undefined;
        await sandboxes.keepAwake();
        expect(reported.map(String)).toEqual([
          `Error: The idle time of the sandbox ${String((await store.loadMachine(id))?.name)} could not be put off: it is tried again`,
        ]);
        reported.length = 0;
        // Not at every look: a while after.
        now += 59_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(1);
        provider.fail = () => undefined;
        now += 1_000;
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(2);

        // One the provider no longer has is forgotten, with nothing said.
        now += 100_000;
        await sandboxes.wake(id);
        provider.sandboxes.clear();
        await sandboxes.keepAwake();
        await sandboxes.keepAwake();
        expect(provider.asked('keepFor')).toHaveLength(3);
      });

      it('is put off by itself, with no one asking', async () => {
        const { sandboxes, provider, create } = await withAccount({
          options: { times: { ...TIMES, tickMs: 10 } },
        });
        const { id } = (await create()).machine;
        now += 100_000;
        await sandboxes.wake(id);
        await expect.poll(() => provider.asked('keepFor')).toEqual(['sbx-1 3600']);
      });
    });

    describe('a sandbox the engine stops', () => {
      const ref = { actor: 'act_1', task: 'b1' };
      const local = () =>
        new FakeProvider({ kind: 'local', label: 'Local', credential: 'none', idle: 'engine' });

      it('is stopped when nothing was run on it for its idle time, and not while a command runs', async () => {
        const { sandboxes, machines, provider, create } = await withAccount({ provider: local() });
        const { id } = (await create({ idleTimeoutSeconds: 600 })).machine;
        provider.calls.length = 0;

        now += 599_000;
        await sandboxes.keepAwake();
        expect(provider.calls).toEqual([]);

        // A command starts just before: its idle time is put off, with nothing asked of the provider but how it stands.
        await sandboxes.wake(id);
        expect(provider.calls).toEqual(['state sbx-1']);
        await machines.start(id, { ...ref, command: 'sleep 900', cwd: '~' });
        now += 900_000;
        await sandboxes.keepAwake();
        expect(provider.asked('stop')).toEqual([]);
        expect(await deadlineOf(id)).toBe(now + 600_000);

        // It ends: the idle time runs from then, and when it is out the sandbox is stopped, once.
        provider.only.daemon.end(ref);
        await expect.poll(() => machines.busy(id)).toBe(0);
        now += 10_000;
        await sandboxes.keepAwake();
        now += 599_000;
        await sandboxes.keepAwake();
        expect(provider.asked('stop')).toEqual([]);
        now += 1_000;
        await sandboxes.keepAwake();
        await sandboxes.keepAwake();
        expect(provider.asked('stop')).toEqual(['sbx-1']);
        await machines.whenOffline(id);
        expect(provider.only.state).toBe('stopped');
        // No timer of the provider's was ever set: it has none.
        expect(provider.asked('keepFor')).toEqual([]);

        // And it is started again for what needs it.
        await sandboxes.wake(id);
        expect(provider.asked('start')).toEqual(['sbx-1 600']);
        expect((await machines.get(id)).online).toBe(true);
        expect(await deadlineOf(id)).toBe(now + 600_000);
      });

      it('is stopped by the next engine too, which finds when its idle time ran out', async () => {
        const first = await withAccount({ provider: local() });
        const { id } = (await first.create({ idleTimeoutSeconds: 600 })).machine;
        first.sandboxes.close();

        const next = setup({ provider: first.provider });
        closing.push(first.machines);
        first.provider.calls.length = 0;
        now += 600_000;
        await next.sandboxes.keepAwake();
        expect(first.provider.asked('stop')).toEqual(['sbx-1']);
        await first.machines.whenOffline(id);
      });

      it('is asked to stop again a while after it could not be, and left alone once it is gone', async () => {
        const { sandboxes, provider, create } = await withAccount({ provider: local() });
        await create({ idleTimeoutSeconds: 600 });
        provider.calls.length = 0;
        provider.fail = (call) =>
          call === 'stop' ? new ProviderFailed('Local answered 500') : undefined;
        now += 600_000;
        await sandboxes.keepAwake();
        expect(reported).toHaveLength(1);
        reported.length = 0;
        now += 59_000;
        await sandboxes.keepAwake();
        expect(provider.asked('stop')).toHaveLength(1);
        provider.sandboxes.clear();
        provider.fail = () => undefined;
        now += 1_000;
        await sandboxes.keepAwake();
        now += HOUR;
        await sandboxes.keepAwake();
        expect(provider.asked('stop')).toHaveLength(2);
      });
    });

    describe('deleting a sandbox', () => {
      it('deletes it at the provider, disk and all, and removes its machine', async () => {
        const { sandboxes, machines, provider, account, create } = await withAccount();
        const { id } = (await create()).machine;
        await sandboxes.remove(id);
        expect(provider.asked('delete')).toEqual(['sbx-1']);
        expect(provider.sandboxes.size).toBe(0);
        await expect(machines.get(id)).rejects.toBeInstanceOf(MachineNotFound);
        expect((await sandboxes.providers())[0]).toMatchObject({ id: account.id, sandboxes: 0 });

        // What is no sandbox is not deleted as one.
        const { machine } = await machines.add({ name: 'laptop' });
        await expect(sandboxes.remove(machine.id)).rejects.toBeInstanceOf(NotASandbox);
        await expect(sandboxes.remove(id)).rejects.toBeInstanceOf(MachineNotFound);
        expect(await sandboxes.is(machine.id)).toBe(false);
      });

      it('removes nothing when the provider cannot be asked, and is done by asking again', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const { id } = (await create()).machine;
        provider.fail = (call) =>
          call === 'delete' ? new ProviderFailed('Fake could not be reached') : undefined;
        const failed = await sandboxes.remove(id).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(ProviderFailed);
        expect(failed).toMatchObject({
          code: 'sandbox_provider_failed',
          message:
            'The sandbox could not be deleted at Fake, and nothing was removed: try again (Fake could not be reached)',
        });
        expect((await machines.get(id)).online).toBe(true);
        expect(await sandboxes.is(id)).toBe(true);
        provider.fail = () => undefined;
        await sandboxes.remove(id);
        expect(await machines.list()).toEqual([]);
      });

      it('counts one the provider no longer has as deleted, and leaves one there whose credential it refuses', async () => {
        const { sandboxes, machines, provider, create } = await withAccount();
        const gone = (await create()).machine.id;
        const left = (await create()).machine.id;
        provider.sandboxes.delete('sbx-1');
        await sandboxes.remove(gone);

        provider.keys.clear();
        await sandboxes.remove(left);
        expect(await machines.list()).toEqual([]);
        expect(provider.sandboxes.has('sbx-2')).toBe(true);
        expect(reported.map(String)).toEqual([
          `Error: The sandbox of ${left} was left at Fake: it refused the account's credential`,
        ]);
        reported.length = 0;
      });

      it('finds it by its label when the provider’s answer to the create never came', async () => {
        const { sandboxes, machines, provider, account } = await withAccount();
        // As a create leaves things when the engine stops before the answer: a machine that
        // names no sandbox, and a sandbox at the provider that carries its label.
        const { machine } = await machines.add({ name: 'half-made' });
        const sandbox = {
          provider: account.id,
          sandboxId: null,
          vcpu: 2,
          memoryGB: 4,
          idle: 600,
          deadline: null,
        };
        expect(await store.setSandbox(machine.id, sandbox)).toBe(true);
        provider.boots = false;
        await provider.account('good-key').create({
          machine: machine.id,
          name: 'half-made',
          vcpu: 2,
          memoryGB: 4,
          idleSeconds: 600,
          labels: { [LABEL_MACHINE]: machine.id, [LABEL_PROVIDER]: account.id },
          provision: '{}',
          key: 'k',
        });
        expect((await sandboxes.list(account.id))[0]).toMatchObject({
          providerSandboxId: null,
          state: 'starting',
        });
        await sandboxes.remove(machine.id);
        expect(provider.asked('list')).toContain(`${LABEL_MACHINE}=${machine.id}`);
        expect(provider.asked('delete')).toEqual(['sbx-1']);
        expect(await machines.list()).toEqual([]);
      });
    });

    describe('an account’s sandboxes', () => {
      it('are listed with how each stands at the provider, in the engine’s words', async () => {
        const { sandboxes, provider, account, create } = await withAccount();
        const names = ['up', 'asleep', 'lost'];
        for (const one of names) await create({ name: one });
        provider.expire('sbx-2');
        provider.sandboxes.delete('sbx-3');
        const listed = await sandboxes.list(account.id);
        expect(listed.map((one) => [one.machine.name, one.providerSandboxId, one.state])).toEqual([
          ['up', 'sbx-1', 'running'],
          ['asleep', 'sbx-2', 'stopped'],
          ['lost', 'sbx-3', 'gone'],
        ]);
        expect(provider.asked('list').at(-1)).toBe(`${LABEL_PROVIDER}=${account.id}`);

        // When the provider cannot be asked, they are listed all the same.
        provider.fail = (call) =>
          call === 'list' ? new ProviderFailed('Fake could not be reached') : undefined;
        expect((await sandboxes.list(account.id)).map((one) => one.state)).toEqual([
          'unknown',
          'unknown',
          'unknown',
        ]);
        await expect(
          sandboxes.list('prv_00000000000000000000000000' as SandboxProviderId),
        ).rejects.toBeInstanceOf(ProviderNotFound);
      });
    });

    describe('an actor on a sandbox', () => {
      const ON_MACHINE = 'orders@machine';
      const VERSIONS = { [ON_MACHINE]: { definition: { features: ['machine'] } } };
      const bash = (id: string, command: string) =>
        calls({ id, name: 'bash', arguments: { command } });
      const tool = (id: string) => calls({ id, name: 'lookup_order', arguments: {} });

      /** An engine with a provider, a sandbox that has gone to sleep, and an actor on it. */
      const asleep = async (
        script: Parameters<ReturnType<typeof world>['engine']>[0],
        code: { readonly lookup?: AgentFunction; readonly handler?: AgentFunction } = {},
        codeTimeoutMs?: number,
        modelId?: string,
      ) => {
        const provider = new FakeProvider();
        const w = world({ store });
        const one = w.engine(script, {
          ...code,
          versions: VERSIONS,
          options: {
            clock: Date.now,
            secrets: secretsOf(),
            machines: { stopGraceMs: 80 },
            sandboxes: { providers: [provider], times: TIMES },
            ...(codeTimeoutMs === undefined ? {} : { codeTimeoutMs }),
          },
        });
        closing.push({ close: () => void one.it.close({ graceMs: 50 }) });
        await one.deploy(ON_MACHINE);
        const machines = one.it.machines as Machines;
        const sandboxes = one.it.sandboxes as Sandboxes;
        provider.machines = machines;
        const account = await sandboxes.addProvider({
          kind: 'fake',
          name: 'main',
          apiKey: 'good-key',
        });
        const made = await sandboxes.create(
          { provider: account.id, vcpu: 2, memoryGB: 4, agents: '*', name: 'builder' },
          ORIGIN,
        );
        const actor = await one.createActor({
          machine: { id: made.machine.id, cwd: '~/work' },
          ...(modelId === undefined ? {} : { modelId }),
        });
        provider.expire('sbx-1');
        await machines.whenOffline(made.machine.id);
        provider.calls.length = 0;
        const results = async () =>
          (await store.conversation(actor.id))
            .filter((entry) => entry.message.role === 'tool_result')
            .map((entry) => JSON.stringify(entry.message));
        return { one, provider, machines, sandboxes, actor, machine: made.machine.id, results };
      };

      it('has it started again for a command, which waits for its daemon and then runs', async () => {
        const { one, provider, actor, results } = await asleep([
          bash('c1', 'echo hi'),
          says('Done.'),
        ]);
        provider.only.daemon.onRun = (params) => {
          provider.only.daemon.end({
            actor: String(params['actor']),
            task: String(params['task']),
          });
        };
        await one.say(actor.id, 'Go.');
        await one.it.settled(actor.id);
        expect(provider.calls).toEqual(['state sbx-1', 'start sbx-1 3600']);
        expect(provider.only.daemon.asked('run')).toHaveLength(1);
        expect((await results())[0]).toContain('hi');
      });

      it('is told why, when it cannot be had for a command: nothing is run', async () => {
        const { one, provider, actor, results } = await asleep([
          bash('c1', 'echo hi'),
          says('Oh.'),
        ]);
        provider.sandboxes.clear();
        await one.say(actor.id, 'Go.');
        await one.it.settled(actor.id);
        expect((await results())[0]).toContain(
          'Your machine, builder, was a sandbox, and it no longer exists: nothing was run.',
        );
      });

      it('has it started again for a file its agent’s code reads, and is told why when it cannot be', async () => {
        const reads: AgentFunction = async (_args, _context, _signal, host) => {
          const read = await host.file({ op: 'read', path: 'a.txt', from: 0 });
          return Buffer.from(read?.data ?? '', 'base64').toString();
        };
        const { one, provider, actor, results } = await asleep(
          [tool('c1'), says('One.'), tool('c2'), says('Two.')],
          { lookup: reads },
        );
        provider.only.daemon.files.set('a.txt', Buffer.from('kept'));
        await one.say(actor.id, 'Read.');
        await one.it.settled(actor.id);
        expect(provider.asked('start')).toEqual(['sbx-1 3600']);
        expect((await results())[0]).toContain('kept');

        provider.expire('sbx-1');
        provider.boots = false;
        await one.say(actor.id, 'Again.');
        await one.it.settled(actor.id);
        expect((await results())[1]).toContain('is a sandbox that is still starting up');
      });

      it('does not count the time its sandbox takes to start against the time its code has', async () => {
        // What makes of what an actor is sent has 150 ms, and its sandbox takes 300 to start.
        const { one, provider, actor } = await asleep(
          [says('Got it.')],
          {
            handler: async (_payload, _context, _signal, host) => {
              await host.file({ op: 'write', path: 'in.txt', from: 0, size: 2, data: 'aGk=' });
              return 'A file is in in.txt.';
            },
          },
          150,
        );
        provider.wait = async (call) => {
          if (call === 'start') await sleep(300);
        };
        await one.say(actor.id, 'hi');
        await one.it.settled(actor.id);
        expect(provider.only.daemon.files.get('in.txt')?.toString()).toBe('hi');
        expect((await store.conversation(actor.id)).map((entry) => entry.message.role)).toEqual([
          'user',
          'assistant',
        ]);
      });
    });
  });
}
