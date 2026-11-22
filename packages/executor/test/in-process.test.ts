import { describe, expect, it } from 'vitest';

import { Providers } from '@acentric/ai';
import { ScriptedRunner, calls, fakeProvider, says } from '@acentric/ai/testing';
import { Engine, InvalidConfiguration, InvalidInput, MemoryStore } from '@acentric/core';
import { BUNDLE_PROTOCOL, makeId } from '@acentric/protocol';

import { BundleError, InProcessExecutor, UnsupportedProtocol } from '../src/index.ts';
import { built, bundle } from './bundle.ts';
import { executorSuite } from './executor-suite.ts';

executorSuite('in this process', async (loading, secrets) => {
  const executor = new InProcessExecutor({ secrets: (_agent, name) => secrets[name] });
  for (const { deployment, code, agent } of loading)
    await executor.load(deployment, { code, agent });
  return executor;
});

const source = (fill: number) => ({
  now: 1_795_305_600_000,
  random: new Uint8Array(10).fill(fill),
});
const agent = { id: makeId('agent', source(1)), name: 'support' };
const deployment = makeId('deployment', source(2));

describe('a bundle', () => {
  it('is one module with everything in it, for no platform in particular', async () => {
    const { code, imports } = await built('orders');
    expect(imports).toEqual([]);
    expect(code).not.toContain('node:');
  });

  it('carries little of the framework: the engine’s schemas are not in it', async () => {
    const code = await bundle('plain');
    // An agent that brings no schema library is the framework and its own few lines.
    expect(code.length).toBeLessThan(20_000);
    // Text only the engine's own schemas have.
    expect(code).not.toContain('made by the engine');
    expect(code).toContain('acentric.bundle');
  });
});

describe('loading code', () => {
  const load = (code: string) => new InProcessExecutor().load(deployment, { code, agent });

  it('gives what the code says it is', async () => {
    const definition = await load(await bundle('plain'));
    expect(definition).toEqual({
      provider: 'fake',
      instructions: 'You say hello.',
      configuration: null,
      tools: [
        {
          name: 'hello',
          description: 'Says hello.',
          parameters: { type: 'object', properties: {} },
          retrySafe: false,
        },
      ],
      inputs: [],
    });
  });

  it('refuses code that does not load, exports no agent, or exports what is not one', async () => {
    await expect(load('throw new Error("on load")')).rejects.toThrow(/does not load: on load/);
    await expect(load('this is not JavaScript')).rejects.toBeInstanceOf(BundleError);
    await expect(load('export const agent = 1;')).rejects.toThrow(/exports no agent/);
    await expect(load('export default { provider: "openai", instructions: "" };')).rejects.toThrow(
      /exports no agent/,
    );
  });

  it('refuses code built for a protocol this engine does not run, and says which it runs', async () => {
    const newer = `export default { [Symbol.for('acentric.bundle')]: { protocol: ${String(BUNDLE_PROTOCOL + 1)}, describe() {}, call() {} } };`;
    await expect(load(newer)).rejects.toBeInstanceOf(UnsupportedProtocol);
    await expect(load(newer)).rejects.toMatchObject({ code: 'unsupported_protocol' });
    await expect(load(newer)).rejects.toThrow(/this engine runs 1/);
  });

  it('refuses code whose agent is not one, with what is wrong with it', async () => {
    const twice = (await bundle('plain')).replace(
      'tools: [',
      'tools: [{ name: "hello", description: "Again.", parameters: nothing, execute: () => "" }, ',
    );
    await expect(load(twice)).rejects.toThrow(/Two tools are named hello/);
    await expect(load(twice)).rejects.toMatchObject({ code: 'invalid_agent' });
  });
});

describe('a turn, with a real agent’s code', () => {
  const lookup = (argument: unknown) =>
    calls({ id: 'c1', name: 'lookup_order', arguments: argument as never });
  const world = async (script: Parameters<typeof calls>[0][] | ReturnType<typeof says>[]) => {
    const executor = new InProcessExecutor({ secrets: () => 'k-1' });
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
        { type: 'text', text: 'Order 4411 was refunded twice, one second apart. (asked with k-1)' },
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
    expect(deployed.deployment.definition.tools.map((tool) => tool.name)).toContain('lookup_order');
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
