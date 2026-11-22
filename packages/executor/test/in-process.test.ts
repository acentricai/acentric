import { describe, expect, it } from 'vitest';

import { BUNDLE_PROTOCOL, makeId } from '@acentric/protocol';

import { BundleError, InProcessExecutor, UnsupportedProtocol } from '../src/index.ts';
import { built, bundle } from './bundle.ts';
import { executorSuite } from './executor-suite.ts';
import { turnSuite } from './turn-suite.ts';

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

turnSuite('in this process', async (secrets) => new InProcessExecutor({ secrets }));
