// Type tests: this file is only compiled, as part of the build. It is the old harness's own,
// kept as it was but for two cases, so that what agents written for it rely on still holds:
// a provider the framework does not know is now taken, and Claude is no provider of its own.
// It is not formatted, since a `@ts-expect-error` must stay on the line above what fails. Each
// `@ts-expect-error` must be over a line that fails to compile, and each
// `Expect<Equal<…>>` must hold.

import { z } from 'zod';

import { Agent, tool } from '../src/index.ts';
import type {
  AgentOptions,
  ConfigurationOf,
  Context,
  CreateActor,
  CreateActorOf,
  InputsOf,
  Machine,
  StandardSchemaV1,
  WebSearchOptions,
} from '../src/index.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// The smallest agent

const smallest = new Agent({ provider: 'anthropic', instructions: 'You review changes.' });

// An agent with every part

const Configuration = z.object({
  customer: z.string(),
  unit: z.enum(['hours', 'days']).default('hours'),
});

const Order = z.object({ id: z.string(), lines: z.number().default(10) });

/** A tool written outside an agent, which reads no configuration. */
const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Finds an order by its ID.',
  parameters: Order,
  // A read: safe to make again after a crash.
  retrySafe: true,
  execute: async ({ id, lines }, { secrets }) => {
    const key = await secrets.get('ORDERS_API_KEY');
    return `${id} ${lines.toFixed(0)} ${key}`;
  },
});

/** A tool written outside an agent, which says what configuration it expects. */
const customerNotes = tool({
  name: 'customer_notes',
  description: "Reads the notes kept on the actor's customer.",
  parameters: z.object({}),
  codemode: true,
  execute: (_args, context: Context<{ readonly customer: string }>) =>
    `Notes of ${context.configuration.customer}`,
});

const Push = z.object({ ref: z.string(), commits: z.number() });

const full = new Agent({
  provider: 'anthropic',
  instructions: 'You help with order questions.',
  configuration: Configuration,
  tools: [
    lookupOrder,
    customerNotes,
    // A tool written in its agent gets its own arguments and the agent's configuration.
    {
      name: 'estimate',
      description: 'Estimates the work, in the unit the actor was configured with.',
      parameters: z.object({ tasks: z.array(z.string()) }),
      execute: ({ tasks }, { configuration, actor }) =>
        `${tasks.length} ${configuration.unit} for ${configuration.customer} (${actor})`,
    },
  ],
  mcps: {
    docs: { url: 'https://example.com/mcp', headers: { 'x-team': 'support' } },
    github: {
      url: 'https://api.githubcopilot.com/mcp/',
      headers: async ({ secrets, configuration }) => ({
        Authorization: `Bearer ${await secrets.get('GITHUB_TOKEN')}`,
        'x-customer': configuration.customer,
      }),
    },
  },
  inputs: {
    message: {
      schema: z.object({ text: z.string() }),
      handler: ({ text }) => text,
    },
    'github.push': {
      schema: Push,
      handler: (push, { configuration }) => [
        { type: 'text', text: `${push.commits.toFixed(0)} commits to ${push.ref}` },
        { type: 'text', text: `for ${configuration.customer}` },
      ],
    },
  },
  subagents: [
    { id: 'explorer', description: 'Reads a codebase and answers questions about it.' },
    {
      id: 'reviewer',
      description: 'Reviews a change.',
      params: {
        // What the model fills in, and what the new actor is created with from it.
        schema: z.object({ strict: z.boolean().describe('Whether it refuses on any doubt') }),
        create: ({ strict }, { machine, reasoning, configuration }) => ({
          machine,
          modelId: 'claude-opus-5-5',
          reasoning: strict ? 'high' : reasoning,
          configuration: { strict, customer: configuration.customer },
        }),
      },
    },
    {
      id: 'scribe',
      description: 'Writes things down.',
      // With no schema the model gives nothing, and the agent decides alone.
      params: { create: (_nothing, { modelId }) => ({ machine: null, modelId }) },
    },
  ],
  compactionSettings: {
    'claude-opus-5-5': { threshold: 800_000, reserve: 50_000 },
    'a-model-the-types-do-not-know': { threshold: 100_000 },
  },
});

// What is read off an agent

export type Tests = [
  Expect<Equal<ConfigurationOf<typeof smallest>, undefined>>,
  Expect<
    Equal<ConfigurationOf<typeof full>, { customer: string; unit: 'hours' | 'days' }>
  >,
  Expect<
    Equal<
      InputsOf<typeof full>,
      {
        readonly message: { text: string };
        readonly 'github.push': { ref: string; commits: number };
      }
    >
  >,
  // An agent's provider, kept as it was written.
  Expect<Equal<(typeof full)['provider'], 'anthropic'>>,
];

// Creating an actor

export const created: CreateActorOf<typeof full>[] = [
  // The schema's defaults may be left out.
  { configuration: { customer: 'acme' } },
  {
    modelId: 'claude-sonnet-5-5',
    reasoning: 'xhigh',
    configuration: { customer: 'acme', unit: 'days' },
  },
  // A model the types do not know is taken too.
  { modelId: 'claude-next', configuration: { customer: 'acme' } },
];

// @ts-expect-error The agent's configuration has a required field, so one must be given.
export const withoutConfiguration: CreateActorOf<typeof full> = { modelId: 'claude-opus-5-5' };

export const ofSmallest: CreateActorOf<typeof smallest> = { reasoning: 'low' };

// @ts-expect-error An agent with no `configuration` schema takes none.
export const unexpected: CreateActorOf<typeof smallest> = { configuration: { customer: 'acme' } };

// @ts-expect-error A reasoning level is one of the five.
export const tooHard: CreateActor = { reasoning: 'extreme' };

// What does not compile

new Agent({
  provider: 'openai',
  instructions: '',
  subagents: [
    { id: 'plain', description: 'Has nothing to fill in.' },
    {
      id: 'typed',
      description: 'Is created from what the model fills in.',
      params: {
        schema: z.object({ depth: z.number() }),
        // @ts-expect-error depth is a number, as the schema says.
        create: ({ depth }) => ({ modelId: depth.toUpperCase() }),
      },
    },
    {
      id: 'wrong',
      description: 'Returns what an actor is not created with.',
      // @ts-expect-error A reasoning level is one of the five.
      params: { create: () => ({ reasoning: 'extreme' }) },
    },
  ],
});

// A provider the framework does not know is taken as it is: providers are the engine's to
// have, and it says at the deploy whether it has this one.
const unknownProvider = new Agent({ provider: 'mistral', instructions: '', webSearch: true });
type UnknownProvider = [Expect<Equal<(typeof unknownProvider)['provider'], 'mistral'>>];

// @ts-expect-error An agent has instructions.
new Agent({ provider: 'openai' });

new Agent({
  provider: 'openai',
  instructions: '',
  // @ts-expect-error This tool expects a customer, and the agent's actors have no configuration.
  tools: [customerNotes],
});

tool({
  name: 'broken',
  description: 'Uses its arguments as what they are not.',
  parameters: Order,
  // @ts-expect-error `id` is a string.
  execute: ({ id }) => id.toFixed(0),
});

tool({
  name: 'nothing',
  description: 'Returns what is not content.',
  parameters: z.object({}),
  // @ts-expect-error A tool returns text, or content parts.
  execute: () => 42,
});

/** A schema that validates and has no JSON Schema to give. */
declare const validatesOnly: StandardSchemaV1<unknown, { readonly id: string }>;

tool({
  name: 'unlisted',
  description: 'Its arguments cannot be told to the model.',
  // @ts-expect-error A tool's schema must also give its JSON Schema.
  parameters: validatesOnly,
  execute: () => '',
});

new Agent({
  provider: 'openai',
  instructions: '',
  // An input's schema only validates: it needs no JSON Schema.
  inputs: { order: { schema: validatesOnly, handler: ({ id }) => id } },
});

new Agent({
  provider: 'openai',
  instructions: '',
  inputs: {
    'github.push': {
      schema: Push,
      // @ts-expect-error `ref` is a string.
      handler: (push) => push.ref.toFixed(0),
    },
  },
});

new Agent({
  provider: 'openai',
  instructions: '',
  // @ts-expect-error A subagent has a description.
  subagents: [{ id: 'explorer' }],
});

new Agent({
  provider: 'openai',
  instructions: '',
  compactionSettings: {
    // @ts-expect-error Compaction has a threshold and a reserve, and nothing else.
    'gpt-6.1-sol': { threshold: 400_000, keepRecent: 50_000 },
  },
});

new Agent({
  provider: 'openai',
  instructions: '',
  // @ts-expect-error An agent has no hooks.
  hooks: {},
});

tool({
  name: 'charge',
  description: 'Charges a card.',
  parameters: z.object({ amount: z.number() }),
  // @ts-expect-error A tool is safe to run again after a crash, or it is not.
  retrySafe: 'sometimes',
  execute: () => '',
});

// A schedule handler gets the times as dates, and the agent's configuration.
new Agent({
  provider: 'anthropic',
  instructions: '',
  configuration: z.object({ zone: z.string() }),
  schedule: {
    handler: ({ note, dueAt, firedAt }, { configuration }) =>
      `${note} (${firedAt.toLocaleString('en-IN', { timeZone: configuration.zone })}, due ${dueAt.toISOString()})`,
  },
});

new Agent({
  provider: 'anthropic',
  instructions: '',
  schedule: {
    // @ts-expect-error A schedule handler returns text.
    handler: () => [{ type: 'text', text: 'Now.' }],
  },
});

// Web search is on, or held to some sites, where the provider has one.
new Agent({ provider: 'anthropic', instructions: '', webSearch: true });
new Agent({ provider: 'openai', instructions: '', webSearch: { allowedDomains: ['docs.python.org'] } });
new Agent({ provider: 'chatgpt', instructions: '', webSearch: { blockedDomains: ['example.com'] } });
new Agent({ provider: 'claude', instructions: '', webSearch: true });
const searching = new Agent({ provider: 'anthropic', instructions: '', webSearch: { allowedDomains: ['a.com'] } });
const searchSetting: true | WebSearchOptions | undefined = searching.webSearch;
void searchSetting;

// @ts-expect-error Fireworks has no web search.
new Agent({ provider: 'fireworks', instructions: '', webSearch: true });
// @ts-expect-error Only some sites, or all but some: not both.
new Agent({ provider: 'anthropic', instructions: '', webSearch: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] } });
// @ts-expect-error On, or settings: not off by `false`; it is left out.
new Agent({ provider: 'openai', instructions: '', webSearch: false });

// An agent whose actors work on a machine: each is created with one, and its code has it.
const lookupNote = tool({
  name: 'look',
  description: 'Reads a note, on a machine when there is one.',
  parameters: z.object({}),
  // Written apart from any agent, it may or may not have a machine.
  execute: async (_args, { machine }) => (machine === null ? 'no machine' : machine.readText('note.txt')),
});
const onMachine = new Agent({
  provider: 'anthropic',
  instructions: '',
  machine: true,
  tools: [
    lookupNote,
    {
      name: 'save',
      description: 'Saves a note.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }, { machine }) => {
        await machine.write('note.txt', text);
        await machine.write('raw.bin', new Uint8Array([1, 2]));
        const bytes: Uint8Array = await machine.read('raw.bin');
        return `${String(bytes.length)} bytes in ${machine.cwd} on ${machine.id}`;
      },
    },
  ],
  inputs: {
    upload: {
      schema: z.object({ name: z.string() }),
      handler: async ({ name }, { machine }) => {
        await machine.write(`inbox/${name}`, 'x');
        return name;
      },
    },
  },
});
type OnMachine = [Expect<Equal<(typeof onMachine)['machine'], true>>];
export const onMachineActors: CreateActorOf<typeof onMachine>[] = [{ machine: { id: 'laptop', cwd: '~/work' } }];
// @ts-expect-error An actor of an agent whose actors work on a machine is created with one.
export const noMachineGiven: CreateActorOf<typeof onMachine> = {};

// An agent that says nothing has none: no machine is given, and its code has none.
const offMachine = new Agent({
  provider: 'anthropic',
  instructions: '',
  tools: [
    lookupNote,
    {
      name: 'nothing',
      description: '',
      parameters: z.object({}),
      execute: (_args, { machine }) => {
        const none: null = machine;
        return String(none);
      },
    },
  ],
});
type OffMachine = [Expect<Equal<(typeof offMachine)['machine'], false>>];
// @ts-expect-error An actor of an agent with no machine is given none.
export const machineGiven: CreateActorOf<typeof offMachine> = { machine: { id: 'laptop', cwd: '~' } };
new Agent({
  provider: 'anthropic',
  instructions: '',
  machine: false,
  tools: [
    {
      name: 'reads',
      description: '',
      parameters: z.object({}),
      // @ts-expect-error An agent with no machine has no files to read.
      execute: (_args, { machine }) => machine.readText('a'),
    },
  ],
});
const machineType: Machine | null = null;
void machineType;
// Options that say nothing of a machine are of an agent with none.
type OptionsDefault = [Expect<Equal<AgentOptions['machine'], false | undefined>>];
export type MachineTypes = [OnMachine, OffMachine, OptionsDefault];

// What is new since the old harness

/** The secrets an agent reads are named, and its code is told more of the actor it runs for. */
const withSecrets = new Agent({
  provider: 'anthropic',
  instructions: '',
  secrets: ['ORDERS_API_KEY'],
  tools: [
    {
      name: 'whoami',
      description: 'Says who the actor is.',
      parameters: z.object({}),
      execute: (_args, { agent, agentName, actor, actorName, externalId }) => {
        const ids: [string, string, string, string | null, string | null] = [
          agent,
          agentName,
          actor,
          actorName,
          externalId,
        ];
        return ids.join(' ');
      },
    },
  ],
});
type WithSecrets = [Expect<Equal<(typeof withSecrets)['secrets'], readonly string[]>>];

/** An actor may be created with a name, and with the caller's own ID for it. */
export const named: CreateActorOf<typeof withSecrets> = { name: 'eu-desk', externalId: 'telegram:4411' };

export type More = [UnknownProvider, WithSecrets];
