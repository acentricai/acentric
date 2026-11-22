// What any executor does with an agent's code. The executor in this process is held to it
// here, and the one that keeps code apart from the engine will be, by the same tests.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CallContext, Executor } from '@acentric/core';
import { agentDefinitionSchema, makeId } from '@acentric/protocol';
import type { AgentId, DeploymentId } from '@acentric/protocol';

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
    const context: CallContext = {
      agent: agent.id,
      actor: makeId('actor', source(4)),
      actorName: 'eu-desk',
      externalId: 'telegram:4411',
      configuration: { region: 'eu' },
      modelId: 'fake-1',
      reasoning: 'medium',
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
        await executor.call(first, 'tools.lookup_order.execute', { id: 4411 }, context, signal()),
      ).toEqual({
        ok: true,
        value: 'Order 4411 was refunded twice, one second apart. (asked with k-1)',
      });
    });

    it('tells the code what its agent is called, and of the actor it runs for', async () => {
      const outcome = await executor.call(first, 'tools.whoami.execute', {}, context, signal());
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
      );
      expect(outcome).toMatchObject({ ok: false, kind: 'invalid', issues: [{ path: ['id'] }] });
    });

    it('says what the code threw', async () => {
      expect(await executor.call(first, 'tools.broken.execute', {}, context, signal())).toEqual({
        ok: false,
        kind: 'error',
        error: { name: 'RangeError', message: 'The order is out of range' },
      });
    });

    it('fails a call that reads a secret that is not set, by a name the code can tell', async () => {
      expect(
        await bare.call(first, 'tools.lookup_order.execute', { id: 1 }, context, signal()),
      ).toMatchObject({
        ok: false,
        kind: 'error',
        error: { name: 'SecretNotSet' },
      });
    });

    it('calls an input’s handler, and checks a configuration', async () => {
      expect(
        await executor.call(first, 'inputs.message.handler', { text: 'Hello.' }, context, signal()),
      ).toEqual({
        ok: true,
        value: 'Hello.',
      });
      expect(await executor.call(first, 'configuration.validate', {}, context, signal())).toEqual({
        ok: true,
        value: { region: 'eu' },
      });
      expect(
        await executor.call(first, 'configuration.validate', { region: 5 }, context, signal()),
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
        );
        return Number(/(\d+) lookups$/.exec((outcome as { value: string }).value)?.[1]);
      };
      const before = [await lookups(first), await lookups(second)];
      await executor.call(second, 'tools.lookup_order.execute', { id: 1 }, context, signal());
      await executor.call(second, 'tools.lookup_order.execute', { id: 2 }, context, signal());
      expect([await lookups(first), await lookups(second)]).toEqual([
        before[0],
        (before[1] ?? 0) + 2,
      ]);
    });

    it('stops waiting for a call when it is told to', async () => {
      const stop = new AbortController();
      const call = executor.call(first, 'tools.never.execute', {}, context, stop.signal);
      stop.abort();
      expect(await call).toMatchObject({ ok: false, kind: 'error' });
    });

    it('has nothing for a deployment it was not given', async () => {
      const unknown = makeId('deployment', source(9));
      await expect(
        executor.call(unknown, 'tools.whoami.execute', {}, context, signal()),
      ).rejects.toThrow(/not loaded/);
    });
  });
}
