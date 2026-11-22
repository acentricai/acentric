// A deploy and a turn through the whole engine, with a real agent's code, built as the command
// will build it. Every executor is held to it.

import { afterAll, describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import { ScriptedRunner, calls, fakeProvider, says } from '@acentric/ai/testing';
import { Engine, InvalidConfiguration, InvalidInput, MemoryStore } from '@acentric/core';
import type { Executor } from '@acentric/core';
import { BUNDLE_PROTOCOL } from '@acentric/protocol';

import type { SecretSource } from '../src/index.ts';
import { bundle } from './bundle.ts';

export function turnSuite(
  name: string,
  /** An executor that gives the agent's code these secrets. */
  start: (secrets: SecretSource) => Promise<Executor>,
): void {
  const started: Executor[] = [];
  afterAll(async () => {
    for (const one of started as { close?: () => Promise<void> }[]) await one.close?.();
  });

  describe(`a turn, with a real agent’s code, run ${name}`, () => {
    const lookup = (argument: unknown) =>
      calls({ id: 'c1', name: 'lookup_order', arguments: argument as never });
    const world = async (script: Parameters<typeof calls>[0][] | ReturnType<typeof says>[]) => {
      const executor = await start(() => 'k-1');
      started.push(executor);
      const store = new MemoryStore();
      const runner = new ScriptedRunner(script as never);
      const providers = new Providers([fakeProvider(runner)]);
      const engine = new Engine({ store, executor, runner, providers });
      // The code is deployed as the command will deploy it: built, and sent with what built it.
      const deployed = await engine.deploy({
        agent: 'support',
        manifest: { protocol: BUNDLE_PROTOCOL, sdk: '0.15.0' },
        code: await bundle('orders'),
      });
      const { actor } = await engine.createActor({
        agent: deployed.agent.id,
        configuration: { region: 'eu' },
      });
      return { engine, store, runner, actor, deployed };
    };

    it('takes a message, runs the agent’s tool, and ends with the model’s answer', async () => {
      const { engine, store, runner, actor } = await world([
        lookup({ id: 4411 }),
        says('It was refunded twice.'),
      ] as never);
      await engine.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
      await engine.settled(actor.id);

      const conversation = await store.conversation(actor.id);
      expect(conversation.map((entry) => entry.message.role)).toEqual([
        'user',
        'assistant',
        'tool_result',
        'assistant',
      ]);
      expect(conversation[0]?.message).toMatchObject({
        content: [{ type: 'text', text: 'Why two refunds?' }],
      });
      expect(conversation[2]?.message).toMatchObject({
        isError: false,
        content: [
          {
            type: 'text',
            text: 'Order 4411 was refunded twice, one second apart. (asked with k-1)',
          },
        ],
      });
      // The model was offered the agent's tools, by what their schemas say.
      expect(runner.steps[0]?.instructions).toBe('You answer questions about orders.');
      expect(runner.steps[0]?.tools.map((tool) => tool.name)).toEqual([
        'lookup_order',
        'whoami',
        'broken',
        'never',
      ]);
      expect(runner.steps[0]?.tools[0]?.parameters).toMatchObject({
        type: 'object',
        required: ['id'],
      });
    });

    it('tells the model what was wrong with what it called a tool with, so that it can call it right', async () => {
      const { engine, store, actor } = await world([
        lookup({ id: 'forty-four eleven' }),
        calls({ id: 'c2', name: 'lookup_order', arguments: { id: 4411 } }),
        says('It was refunded twice.'),
      ] as never);
      await engine.send(actor.id, { type: 'message', payload: { text: 'Why two refunds?' } });
      await engine.settled(actor.id);

      const results = (await store.conversation(actor.id)).filter(
        (entry) => entry.message.role === 'tool_result',
      );
      expect(results[0]?.message).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringMatching(
              /^The arguments are not what lookup_order takes\. id: /,
            ) as string,
          },
        ],
      });
      expect(results[1]?.message).toMatchObject({ isError: false });
    });

    it('refuses an input its schema refuses, with what is wrong, and stores nothing', async () => {
      const { engine, store, actor } = await world([]);
      const sent = engine.send(actor.id, { type: 'message', payload: { text: 5 } });
      await expect(sent).rejects.toBeInstanceOf(InvalidInput);
      await expect(sent).rejects.toMatchObject({
        code: 'invalid_input',
        issues: [{ path: ['text'] }],
      });
      expect(await store.pendingInputs(actor.id)).toEqual([]);
    });

    it('is deployed as an agent, with what its code said, and the secrets it still lacks', async () => {
      const { engine, deployed } = await world([]);
      expect(deployed.created).toBe(true);
      expect(deployed.agent).toMatchObject({ name: 'support', provider: 'fake' });
      expect(deployed.deployment).toMatchObject({ version: 1, createdBy: { type: 'system' } });
      expect(deployed.deployment.definition.tools.map((tool) => tool.name)).toContain(
        'lookup_order',
      );
      expect(deployed.missingSecrets).toEqual(['ORDERS_API_KEY']);
      // The same code again is the same deployment.
      const again = await engine.deploy({
        agent: 'support',
        manifest: { protocol: BUNDLE_PROTOCOL, sdk: '0.15.0' },
        code: await bundle('orders'),
      });
      expect(again).toMatchObject({ created: false, deployment: { id: deployed.deployment.id } });
    });

    it('has an actor’s configuration as the agent’s schema returned it, and refuses one it refuses', async () => {
      const { engine, actor, deployed } = await world([]);
      expect(actor.configuration).toEqual({ region: 'eu' });
      // What the schema fills in is part of it.
      const filled = await engine.createActor({ agent: deployed.agent.id, configuration: {} });
      expect(filled.actor.configuration).toEqual({ region: 'eu' });
      // With none given, the schema is asked what it makes of none: this one takes an object.
      await expect(engine.createActor({ agent: deployed.agent.id })).rejects.toBeInstanceOf(
        InvalidConfiguration,
      );

      const refused = engine.createActor({
        agent: deployed.agent.id,
        configuration: { region: 5 },
      });
      await expect(refused).rejects.toBeInstanceOf(InvalidConfiguration);
      await expect(refused).rejects.toMatchObject({
        code: 'invalid_configuration',
        issues: [{ path: ['region'] }],
      });
    });

    it('is not deployed when it is not an agent, and nothing is kept of it', async () => {
      const { engine, store } = await world([]);
      const refused = engine.deploy({
        agent: 'broken',
        manifest: { protocol: BUNDLE_PROTOCOL, sdk: '0.15.0' },
        code: 'export default { not: "an agent" };',
      });
      await expect(refused).rejects.toMatchObject({ code: 'invalid_agent' });
      expect(await store.findAgent('broken')).toBeUndefined();

      const old = engine.deploy({
        agent: 'broken',
        manifest: { protocol: BUNDLE_PROTOCOL + 1, sdk: '9.0.0' },
        code: await bundle('orders'),
      });
      await expect(old).rejects.toMatchObject({ code: 'unsupported_protocol' });
    });
  });
}
