// What a bundle says to the engine: what it is, and what a call of one of its functions
// comes to.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BUNDLE_ENTRY, BUNDLE_PROTOCOL } from '@acentric/protocol/bundle';
import type { BundleContext, BundleEntry, BundleHost } from '@acentric/protocol/bundle';
import { agentDefinitionSchema, makeId } from '@acentric/protocol';

import { Agent, InvalidAgent, tool } from '../src/index.ts';
import type { AnyAgent, Context, StandardSchemaV1 } from '../src/index.ts';

const entryOf = (agent: AnyAgent): BundleEntry =>
  (agent as unknown as { [key: symbol]: BundleEntry })[Symbol.for(BUNDLE_ENTRY)] as BundleEntry;

const source = (fill: number) => ({
  now: 1_795_305_600_000,
  random: new Uint8Array(10).fill(fill),
});
const context: BundleContext = {
  agent: makeId('agent', source(1)),
  agentName: 'support',
  actor: makeId('actor', source(2)),
  actorName: null,
  externalId: 'telegram:4411',
  configuration: { region: 'eu', unit: 'hours' },
  modelId: 'claude-opus-5-5',
  reasoning: 'medium',
};
const host = (secrets: { [name: string]: string } = {}): BundleHost => ({
  secret: async (name) => secrets[name],
});

const Configuration = z.object({
  region: z.string(),
  unit: z.enum(['hours', 'days']).default('hours'),
});

const seen: Context<z.infer<typeof Configuration>>[] = [];
const support = new Agent({
  provider: 'anthropic',
  instructions: 'You answer questions about orders.',
  configuration: Configuration,
  tools: [
    tool({
      name: 'lookup_order',
      description: 'Finds an order by its number.',
      parameters: z.object({ id: z.number().int(), lines: z.number().default(10) }),
      retrySafe: true,
      execute: async ({ id, lines }, { secrets }) =>
        `Order ${String(id)}, ${String(lines)} lines, with ${await secrets.get('ORDERS_API_KEY')}`,
    }),
    {
      name: 'whoami',
      description: 'Says who the actor is.',
      parameters: z.object({}),
      execute: (_args, given) => {
        seen.push(given);
        return [{ type: 'text', text: `${given.agentName} in ${given.configuration.region}` }];
      },
    },
    {
      name: 'broken',
      description: 'Fails.',
      parameters: z.object({}),
      execute: () => {
        throw new RangeError('The order is out of range');
      },
    },
    {
      name: 'show_again',
      description: 'Gives back an image the conversation has, by its name.',
      parameters: z.object({ digest: z.string() }),
      execute: ({ digest }) => [
        { type: 'image', source: { type: 'blob', digest, mediaType: 'image/png', size: 300 } },
      ],
    },
    {
      name: 'not_content',
      description: 'Returns what is not content.',
      parameters: z.object({}),
      execute: () => ({ rows: 3 }) as unknown as string,
    },
  ],
  inputs: {
    message: { schema: z.object({ text: z.string() }), handler: ({ text }) => text },
    'github.push': {
      schema: z.object({ ref: z.string(), commits: z.number() }),
      handler: (push, { configuration }) => [
        { type: 'text', text: `${String(push.commits)} commits to ${push.ref}` },
        { type: 'text', text: `for ${configuration.region}` },
      ],
    },
  },
  webSearch: { allowedDomains: ['example.com'] },
  secrets: ['ORDERS_API_KEY'],
});
const entry = entryOf(support);

describe('what a bundle says it is', () => {
  it('is everything of its definition that is data', () => {
    const definition = entry.describe();
    expect(definition).toMatchObject({
      provider: 'anthropic',
      instructions: 'You answer questions about orders.',
      providerOptions: { webSearch: { allowedDomains: ['example.com'] } },
      secrets: ['ORDERS_API_KEY'],
    });
    expect(definition.features).toBeUndefined();
    expect(definition.tools.map((one) => [one.name, one.retrySafe])).toEqual([
      ['lookup_order', true],
      ['whoami', false],
      ['broken', false],
      ['show_again', false],
      ['not_content', false],
    ]);
    expect(definition.tools[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { id: { type: 'integer' }, lines: { type: 'number', default: 10 } },
      required: ['id'],
    });
    expect(definition.inputs.map((one) => one.type)).toEqual(['message', 'github.push']);
    expect(definition.inputs[0]?.schema).toMatchObject({ type: 'object', required: ['text'] });
    expect(definition.configuration?.schema).toMatchObject({
      type: 'object',
      required: ['region'],
    });
    // It is what the engine's own schema of a definition takes.
    expect(agentDefinitionSchema.parse(definition)).toEqual(definition);
  });

  it('speaks the protocol of the framework it was built with', () => {
    expect(entry.protocol).toBe(BUNDLE_PROTOCOL);
  });

  it('is little for the smallest agent', () => {
    const smallest = new Agent({ provider: 'openai', instructions: 'You review changes.' });
    expect(entryOf(smallest).describe()).toEqual({
      provider: 'openai',
      instructions: 'You review changes.',
      configuration: null,
      tools: [],
      inputs: [],
    });
  });

  it('names what it uses that an engine may not have', () => {
    const uses = new Agent({
      provider: 'anthropic',
      machine: true,
      instructions: '',
      tools: [
        {
          name: 'in_scripts',
          description: 'For the model’s scripts.',
          parameters: z.object({}),
          codemode: true,
          execute: () => '',
        },
      ],
      mcps: { docs: { url: 'https://example.com/mcp' } },
      subagents: [{ id: 'explorer', description: 'Reads a codebase.' }],
      schedule: { handler: ({ note }) => note },
      compactionSettings: { 'claude-opus-5-5': { threshold: 800_000 } },
    });
    const definition = entryOf(uses).describe();
    expect(definition.features).toEqual([
      'machine',
      'mcps',
      'subagents',
      'schedule',
      'compaction-settings',
      'codemode',
    ]);
    // A tool of the model's scripts is not one the model is offered.
    expect(definition.tools).toEqual([]);
  });

  it('refuses what is not an agent, and says what is wrong with it', () => {
    const noJsonSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'mine', validate: (value) => ({ value }) },
    };
    const withTools = (...tools: unknown[]) =>
      new Agent({ provider: 'openai', instructions: '', tools: tools as never });
    const one = (more: object) => ({
      name: 'a_tool',
      description: 'Does it.',
      parameters: z.object({}),
      execute: () => '',
      ...more,
    });
    const refused: [AnyAgent, RegExp][] = [
      [withTools(one({}), one({})), /Two tools are named a_tool/],
      [withTools(one({ name: 'bash' })), /one of the engine's own tools/],
      [withTools(one({ name: 'two words' })), /a tool's name is 1 to 64 letters/],
      [withTools(one({ description: '' })), /has no description/],
      [withTools(one({ execute: 'later' })), /has no execute function/],
      [withTools(one({ parameters: {} })), /is not a schema/],
      [withTools(one({ parameters: noJsonSchema })), /cannot give its JSON Schema/],
      [withTools(one({ parameters: z.string() })), /are an object/],
      [withTools(one({ retrySafe: 'yes' })), /retrySafe of the tool a_tool is true or false/],
      [new Agent({ provider: '', instructions: '' }), /has no provider/],
      [new Agent({ provider: 'openai', instructions: 5 as never }), /instructions are not text/],
      [
        new Agent({ provider: 'openai', instructions: '', secrets: ['two words'] }),
        /A secret is named/,
      ],
      [
        new Agent({
          provider: 'openai',
          instructions: '',
          inputs: { 'two words': { schema: z.string(), handler: (text: string) => text } },
        }),
        /An input has the type/,
      ],
    ];
    for (const [agent, why] of refused) {
      expect(() => entryOf(agent).describe(), String(why)).toThrow(InvalidAgent);
      expect(() => entryOf(agent).describe(), String(why)).toThrow(why);
    }
  });
});

describe('a call of a tool', () => {
  it('checks the arguments, fills in what they default, and gives what the tool returns', async () => {
    const outcome = await entry.call(
      'tools.lookup_order.execute',
      { id: 4411 },
      context,
      host({ ORDERS_API_KEY: 'k' }),
    );
    expect(outcome).toEqual({ ok: true, value: 'Order 4411, 10 lines, with k' });
  });

  it('does not run the tool on arguments its schema refuses, and says what is wrong with them', async () => {
    const outcome = await entry.call('tools.lookup_order.execute', { id: 'many' }, context, host());
    expect(outcome).toMatchObject({ ok: false, kind: 'invalid' });
    expect(outcome).toHaveProperty('issues.0.path', ['id']);
  });

  it('gives the tool the actor it runs for, with its configuration as it was stored', async () => {
    seen.length = 0;
    const outcome = await entry.call('tools.whoami.execute', {}, context, host());
    expect(outcome).toEqual({ ok: true, value: [{ type: 'text', text: 'support in eu' }] });
    expect(seen[0]).toMatchObject({
      agent: context.agent,
      agentName: 'support',
      actor: context.actor,
      actorName: null,
      externalId: 'telegram:4411',
      configuration: { region: 'eu', unit: 'hours' },
      modelId: 'claude-opus-5-5',
      reasoning: 'medium',
      machine: null,
    });
  });

  it('says what the tool threw', async () => {
    expect(await entry.call('tools.broken.execute', {}, context, host())).toEqual({
      ok: false,
      kind: 'error',
      error: { name: 'RangeError', message: 'The order is out of range' },
    });
  });

  it('fails for a secret that is not set, by a name the code can tell it by', async () => {
    const outcome = await entry.call('tools.lookup_order.execute', { id: 1 }, context, host());
    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      error: { name: 'SecretNotSet', message: 'The agent has no secret named ORDERS_API_KEY' },
    });
  });

  it('takes content that names a blob: whether the actor has it is the engine’s to say', async () => {
    const digest = 'ab'.repeat(32);
    expect(await entry.call('tools.show_again.execute', { digest }, context, host())).toEqual({
      ok: true,
      value: [
        { type: 'image', source: { type: 'blob', digest, mediaType: 'image/png', size: 300 } },
      ],
    });
  });

  it('fails when the tool returns what is not content, or there is no such tool', async () => {
    expect(await entry.call('tools.not_content.execute', {}, context, host())).toMatchObject({
      ok: false,
      kind: 'error',
      error: { message: expect.stringContaining('returned what is not content') as string },
    });
    expect(await entry.call('tools.gone.execute', {}, context, host())).toMatchObject({
      ok: false,
      kind: 'error',
      error: { message: 'The agent has no tool gone' },
    });
    expect(await entry.call('tools.lookup_order.describe', {}, context, host())).toMatchObject({
      ok: false,
      kind: 'error',
    });
  });
});

describe('a call of an input’s handler', () => {
  it('gives what the input becomes in the conversation', async () => {
    expect(await entry.call('inputs.message.handler', { text: 'Hello.' }, context, host())).toEqual(
      {
        ok: true,
        value: 'Hello.',
      },
    );
  });

  it('finds a type that has dots in it', async () => {
    const outcome = await entry.call(
      'inputs.github.push.handler',
      { ref: 'main', commits: 3 },
      context,
      host(),
    );
    expect(outcome).toEqual({
      ok: true,
      value: [
        { type: 'text', text: '3 commits to main' },
        { type: 'text', text: 'for eu' },
      ],
    });
  });

  it('refuses a payload its schema refuses, and a type the agent has not', async () => {
    expect(await entry.call('inputs.message.handler', { text: 5 }, context, host())).toMatchObject({
      ok: false,
      kind: 'invalid',
      issues: [{ path: ['text'] }],
    });
    expect(await entry.call('inputs.voice.handler', {}, context, host())).toMatchObject({
      ok: false,
      kind: 'error',
      error: { message: 'The agent has no input voice' },
    });
    // Nothing an object has by being one is an input.
    expect(await entry.call('inputs.constructor.handler', {}, context, host())).toMatchObject({
      ok: false,
      kind: 'error',
    });
  });
});

describe('checking a configuration', () => {
  it('gives it as the schema returns it, with what it defaults', async () => {
    expect(await entry.call('configuration.validate', { region: 'eu' }, context, host())).toEqual({
      ok: true,
      value: { region: 'eu', unit: 'hours' },
    });
  });

  it('says what is wrong with one the schema refuses', async () => {
    expect(
      await entry.call('configuration.validate', { unit: 'weeks' }, context, host()),
    ).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    expect(await entry.call('configuration.validate', null, context, host())).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it('takes none for an agent that has none', async () => {
    const smallest = entryOf(new Agent({ provider: 'openai', instructions: '' }));
    expect(await smallest.call('configuration.validate', null, context, host())).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await smallest.call('configuration.validate', { region: 'eu' }, context, host()),
    ).toMatchObject({
      ok: false,
      kind: 'error',
      error: { message: 'The agent takes no configuration' },
    });
  });

  it('is not mistaken for a refusal when it has a field called issues', async () => {
    const tracker = entryOf(
      new Agent({
        provider: 'openai',
        instructions: '',
        configuration: z.object({ issues: z.array(z.string()) }),
      }),
    );
    expect(
      await tracker.call('configuration.validate', { issues: ['a', 'b'] }, context, host()),
    ).toEqual({
      ok: true,
      value: { issues: ['a', 'b'] },
    });
  });
});
