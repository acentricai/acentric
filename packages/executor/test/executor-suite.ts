// What any executor does with an agent's code. The executor in this process is held to it
// here, and the one that keeps code apart from the engine will be, by the same tests.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_MACHINE } from '@acentric/core';
import type { CallContext, CallHost, Executor } from '@acentric/core';
import { agentDefinitionSchema, makeId } from '@acentric/protocol';
import type { AgentId, DeploymentId, Json } from '@acentric/protocol';

import { bundle } from './bundle.ts';

const source = (fill: number) => ({
  now: 1_795_305_600_000,
  random: new Uint8Array(10).fill(fill),
});

export type Loading = {
  readonly deployment: DeploymentId;
  readonly code: string;
  readonly agent: { readonly id: AgentId; readonly name: string };
};

export function executorSuite(
  name: string,
  /** An executor with the deployments loaded, and the secrets given set for every agent. */
  open: (
    loading: readonly Loading[],
    secrets: { readonly [name: string]: string },
  ) => Promise<Executor>,
): void {
  describe(`an executor: ${name}`, () => {
    const agent = { id: makeId('agent', source(1)), name: 'support' };
    const first = makeId('deployment', source(2));
    const second = makeId('deployment', source(3));
    /** The deployment of an agent whose actors work on a machine. */
    const keeper = makeId('deployment', source(5));
    const context: CallContext = {
      agent: agent.id,
      actor: makeId('actor', source(4)),
      actorName: 'eu-desk',
      externalId: 'telegram:4411',
      configuration: { region: 'eu' },
      modelId: 'fake-1',
      reasoning: 'medium',
      machine: null,
    };
    const signal = () => new AbortController().signal;
    let code: string;
    let executor: Executor;
    let bare: Executor;

    beforeAll(async () => {
      code = await bundle('orders');
      const loading = [
        { deployment: first, code, agent },
        { deployment: second, code, agent },
        { deployment: keeper, code: await bundle('files'), agent },
      ];
      executor = await open(loading, { ORDERS_API_KEY: 'k-1' });
      bare = await open(loading, {});
    });
    afterAll(async () => {
      // An executor that started processes of its own ends them.
      for (const one of [executor, bare] as { close?: () => Promise<void> }[]) await one.close?.();
    });

    it('says what the code is', async () => {
      // Asked again for a deployment it has, it says the same.
      const definition = await executor.load(first, { code, agent });
      expect(agentDefinitionSchema.parse(definition)).toEqual(definition);
      expect(definition).toMatchObject({
        provider: 'fake',
        instructions: 'You answer questions about orders.',
        secrets: ['ORDERS_API_KEY'],
      });
      expect(definition.tools.map((tool) => tool.name)).toEqual([
        'lookup_order',
        'whoami',
        'broken',
        'never',
      ]);
      expect(definition.inputs).toMatchObject([{ type: 'message' }]);
    });

    it('calls a tool, which reads a secret of its agent’s', async () => {
      expect(
        await executor.call(
          first,
          'tools.lookup_order.execute',
          { id: 4411 },
          context,
          signal(),
          NO_MACHINE,
        ),
      ).toEqual({
        ok: true,
        value: 'Order 4411 was refunded twice, one second apart. (asked with k-1)',
      });
    });

    it('tells the code what its agent is called, and of the actor it runs for', async () => {
      const outcome = await executor.call(
        first,
        'tools.whoami.execute',
        {},
        context,
        signal(),
        NO_MACHINE,
      );
      expect(outcome).toMatchObject({ ok: true });
      expect((outcome as { value: string }).value).toMatch(
        /^support\/eu-desk\/telegram:4411 in eu, /,
      );
    });

    it('does not run a tool on what its schema refuses, and says what is wrong', async () => {
      const outcome = await executor.call(
        first,
        'tools.lookup_order.execute',
        { id: 'many' },
        context,
        signal(),
        NO_MACHINE,
      );
      expect(outcome).toMatchObject({ ok: false, kind: 'invalid', issues: [{ path: ['id'] }] });
    });

    it('says what the code threw', async () => {
      expect(
        await executor.call(first, 'tools.broken.execute', {}, context, signal(), NO_MACHINE),
      ).toEqual({
        ok: false,
        kind: 'error',
        error: { name: 'RangeError', message: 'The order is out of range' },
      });
    });

    it('fails a call that reads a secret that is not set, by a name the code can tell', async () => {
      expect(
        await bare.call(
          first,
          'tools.lookup_order.execute',
          { id: 1 },
          context,
          signal(),
          NO_MACHINE,
        ),
      ).toMatchObject({
        ok: false,
        kind: 'error',
        error: { name: 'SecretNotSet' },
      });
    });

    it('calls an input’s handler, and checks a configuration', async () => {
      expect(
        await executor.call(
          first,
          'inputs.message.handler',
          { text: 'Hello.' },
          context,
          signal(),
          NO_MACHINE,
        ),
      ).toEqual({
        ok: true,
        value: 'Hello.',
      });
      expect(
        await executor.call(first, 'configuration.validate', {}, context, signal(), NO_MACHINE),
      ).toEqual({
        ok: true,
        value: { region: 'eu' },
      });
      expect(
        await executor.call(
          first,
          'configuration.validate',
          { region: 5 },
          context,
          signal(),
          NO_MACHINE,
        ),
      ).toMatchObject({
        ok: false,
        kind: 'invalid',
      });
    });

    it('keeps what one deployment’s code holds between calls from another’s, though the code is the same', async () => {
      const lookups = async (deployment: DeploymentId) => {
        const outcome = await executor.call(
          deployment,
          'tools.whoami.execute',
          {},
          context,
          signal(),
          NO_MACHINE,
        );
        return Number(/(\d+) lookups$/.exec((outcome as { value: string }).value)?.[1]);
      };
      const before = [await lookups(first), await lookups(second)];
      await executor.call(
        second,
        'tools.lookup_order.execute',
        { id: 1 },
        context,
        signal(),
        NO_MACHINE,
      );
      await executor.call(
        second,
        'tools.lookup_order.execute',
        { id: 2 },
        context,
        signal(),
        NO_MACHINE,
      );
      expect([await lookups(first), await lookups(second)]).toEqual([
        before[0],
        (before[1] ?? 0) + 2,
      ]);
    });

    it('stops waiting for a call when it is told to', async () => {
      const stop = new AbortController();
      const call = executor.call(
        first,
        'tools.never.execute',
        {},
        context,
        stop.signal,
        NO_MACHINE,
      );
      stop.abort();
      expect(await call).toMatchObject({ ok: false, kind: 'error' });
    });

    it('has nothing for a deployment it was not given', async () => {
      const unknown = makeId('deployment', source(9));
      await expect(
        executor.call(unknown, 'tools.whoami.execute', {}, context, signal(), NO_MACHINE),
      ).rejects.toThrow(/not loaded/);
    });

    describe('the files of an actor’s machine', () => {
      const machine = { id: makeId('machine', source(6)), cwd: '~/work' };
      const on: CallContext = { ...context, machine };

      /** What the engine does for one call: a machine's files, and every request made of it. */
      const filesOf = (files = new Map<string, Buffer>()) => {
        const asked: string[] = [];
        const host: CallHost = {
          file: async (request) => {
            asked.push(`${request.op} ${request.path} ${String(request.from)}`);
            if (request.op === 'read') {
              const file = files.get(request.path);
              if (file === undefined) {
                // As the engine refuses: an error with a name of its own.
                throw Object.assign(new Error(`There is no file ${request.path}`), {
                  name: 'MachineRefused',
                });
              }
              const part = file.subarray(request.from, request.from + (8 << 20));
              return { size: file.length, data: part.toString('base64') };
            }
            const before =
              request.from === 0 ? Buffer.alloc(0) : (files.get(request.path) as Buffer);
            files.set(request.path, Buffer.concat([before, Buffer.from(request.data, 'base64')]));
            return undefined;
          },
        };
        return { host, files, asked };
      };
      const tool = (called: string, args: Json, host: CallHost, sent = on, stop = signal()) =>
        executor.call(keeper, `tools.${called}.execute`, args, sent, stop, host);

      it('are written and read by its agent’s code, through what the engine does for the call', async () => {
        const { host, files, asked } = filesOf();
        expect(await tool('save', { path: 'notes/today.txt', text: 'buy bolts ✓' }, host)).toEqual({
          ok: true,
          value: 'saved notes/today.txt',
        });
        expect(files.get('notes/today.txt')?.toString()).toBe('buy bolts ✓');
        expect(await tool('load', { path: 'notes/today.txt' }, host)).toEqual({
          ok: true,
          value: 'buy bolts ✓',
        });
        expect(asked).toEqual(['write notes/today.txt 0', 'read notes/today.txt 0']);
      });

      it('are written by what turns what an actor is sent into what its model reads', async () => {
        const { host, files } = filesOf();
        const base64 = Buffer.from([137, 80, 78, 71, 0, 255]).toString('base64');
        expect(
          await executor.call(
            keeper,
            'inputs.upload.handler',
            { name: 'logo.png', base64 },
            on,
            signal(),
            host,
          ),
        ).toEqual({ ok: true, value: 'A file is in inbox/logo.png: 6 bytes.' });
        expect([...(files.get('inbox/logo.png') as Buffer)]).toEqual([137, 80, 78, 71, 0, 255]);
      });

      it('are written by what says what the notice of a schedule that fired says', async () => {
        const { host, files } = filesOf();
        const fired = {
          note: 'Check the deploy.',
          dueAt: 1_795_305_600_000,
          firedAt: 1_795_305_600_250,
        };
        expect(await executor.call(keeper, 'schedule.handler', fired, on, signal(), host)).toEqual({
          ok: true,
          value: 'Check the deploy.\nIt is in notes/due.txt.',
        });
        expect(files.get('notes/due.txt')?.toString()).toBe(
          'Check the deploy. (due 2026-11-22T00:00:00.000Z)',
        );
      });

      it('move in parts: bytes more than one request carries, and as many as its code may move', async () => {
        const { host, files, asked } = filesOf();
        // 9 MiB: two requests each way.
        expect(await tool('big', { bytes: 9 << 20 }, host)).toEqual({
          ok: true,
          value: `${String(9 << 20)} true`,
        });
        expect(asked).toEqual([
          'write big.bin 0',
          `write big.bin ${String(8 << 20)}`,
          'read big.bin 0',
          `read big.bin ${String(8 << 20)}`,
        ]);
        expect(files.get('big.bin')?.[(8 << 20) + 5]).toBe(((8 << 20) + 5) % 251);

        expect(await tool('big', { bytes: 32 << 20 }, host)).toEqual({
          ok: true,
          value: `${String(32 << 20)} true`,
        });
        expect(files.get('big.bin')?.length).toBe(32 << 20);
      }, 60_000);

      it('fail for its code with what the engine says is wrong, by its name', async () => {
        const { host } = filesOf();
        expect(await tool('load', { path: 'missing.txt' }, host)).toEqual({
          ok: false,
          kind: 'error',
          error: { name: 'MachineRefused', message: 'There is no file missing.txt' },
        });
        expect(await tool('load', { path: 'a.txt' }, NO_MACHINE)).toEqual({
          ok: false,
          kind: 'error',
          error: { name: 'Error', message: 'The actor has no machine' },
        });
      });

      it('are those of the call that asks: calls at once reach each its own', async () => {
        const one = filesOf(new Map([['who.txt', Buffer.from('one')]]));
        const two = filesOf(new Map([['who.txt', Buffer.from('two')]]));
        const answers = await Promise.all(
          [one, two, one, two].map(({ host }) => tool('load', { path: 'who.txt' }, host)),
        );
        expect(answers.map((answer) => (answer as { value: string }).value)).toEqual([
          'one',
          'two',
          'one',
          'two',
        ]);
      });

      it('are given up with the call that waits for them', async () => {
        const stop = new AbortController();
        let asked = 0;
        let answer: (part: { size: number; data: string }) => void = () => {};
        let reached: () => void = () => {};
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const slow: CallHost = {
          file: () =>
            new Promise((resolve) => {
              asked += 1;
              answer = resolve;
              reached();
            }),
        };
        const call = tool('load', { path: 'slow.txt' }, slow, on, stop.signal);
        await waiting;
        expect(asked).toBe(1);
        stop.abort();
        expect(await call).toMatchObject({ ok: false, error: { name: 'AbortError' } });
        // An answer that comes after is nobody's, and the next call is as any other.
        answer({ size: 2, data: Buffer.from('hi').toString('base64') });
        const { host } = filesOf(new Map([['a.txt', Buffer.from('still here')]]));
        expect(await tool('load', { path: 'a.txt' }, host)).toEqual({
          ok: true,
          value: 'still here',
        });
      });

      it('come with the machine as data: where it is, and the variables its commands are run with', async () => {
        const { host } = filesOf();
        const env = { ORDERS_API_KEY: 'k-1' };
        const said = await tool('what', {}, host, { ...on, machine: { ...machine, env } });
        const withEnv = { ...machine, env };
        expect(JSON.parse((said as { value: string }).value)).toEqual({
          keys: ['id', 'cwd', 'env'],
          spread: withEnv,
          json: withEnv,
        });
      });
    });
  });
}
