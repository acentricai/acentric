// Records what each provider is sent and what it answers, for the tests to replay. It makes
// real calls, which cost a little, so it is run by hand and never by the tests:
//
//   OPENAI_API_KEY=… FIREWORKS_API_KEY=… ANTHROPIC_API_KEY=… node packages/ai/test/record.ts
//
// With the names of providers after it, only those are recorded. With `--scenario=<name>`,
// only the scenarios whose names start so: the others are left as they were recorded.
//
// A provider whose key is not given is left out. What is written holds no key: the headers
// that sign a call are written as `<redacted>`, and a file is refused if a key is found in it.
//
// ChatGPT is recorded with OpenAI's API key standing in for the token of someone signed in.
// The request and the stream it answers with are the real ones; that a real token is taken is
// not shown by it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FunctionTool, Message } from '@acentric/protocol';

import { ModelFailure, builtInProviders } from '../src/index.ts';
import type { Credential, ModelAnswer, ModelStep, Provider } from '../src/index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The headers of an answer that say something a provider's code reads. */
const KEPT_HEADERS = ['content-type', 'retry-after', 'retry-after-ms', 'x-should-retry'];
/** The headers of a request that sign it. */
const SIGNING = ['authorization', 'x-api-key'];

export type Fixture = {
  readonly provider: string;
  readonly scenario: string;
  readonly step: ModelStep;
  readonly request: {
    readonly url: string;
    readonly headers: { readonly [name: string]: string };
    readonly body: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers: { readonly [name: string]: string };
    readonly text: string;
  };
  /** What the provider's code made of it when it was recorded. */
  readonly expected:
    | { readonly answer: ModelAnswer }
    | {
        readonly failure: {
          readonly kind: string;
          readonly retryable: boolean;
          readonly status?: number;
        };
      };
};

const lookup: FunctionTool = {
  type: 'function',
  name: 'lookup_order',
  description: 'Finds an order by its number, and says what happened to it.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'integer', description: 'The number of the order.' } },
    required: ['id'],
    additionalProperties: false,
  },
};

const TARGETS: {
  readonly provider: string;
  readonly env: string;
  readonly model: string;
  readonly type: Credential['type'];
  /** Whether it has a web search of its own. */
  readonly search?: boolean;
}[] = [
  { provider: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-6-luna', type: 'api_key', search: true },
  {
    provider: 'chatgpt',
    env: 'OPENAI_API_KEY',
    model: 'gpt-6-luna',
    type: 'access_token',
    search: true,
  },
  {
    provider: 'fireworks',
    env: 'FIREWORKS_API_KEY',
    model: 'accounts/fireworks/models/glm-5p3-flash',
    type: 'api_key',
  },
  {
    provider: 'anthropic',
    env: 'ANTHROPIC_API_KEY',
    model: 'claude-haiku-5-5',
    type: 'api_key',
    search: true,
  },
];

const credentialOf = (type: Credential['type'], secret: string): Credential =>
  type === 'api_key' ? { type, apiKey: secret } : { type, accessToken: secret };

async function record(
  provider: Provider,
  scenario: string,
  step: ModelStep,
  credential: Credential,
  secrets: readonly string[],
): Promise<ModelAnswer | undefined> {
  if (!wanted(scenario)) return undefined;
  let request: Fixture['request'] | undefined;
  let response: Fixture['response'] | undefined;
  const recording: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as { [name: string]: string }).map(([name, value]) => [
        name,
        SIGNING.includes(name.toLowerCase()) ? '<redacted>' : value,
      ]),
    );
    request = { url: String(input), headers, body: JSON.parse(String(init?.body)) as unknown };
    const answered = await fetch(input, init);
    const text = await answered.clone().text();
    response = {
      status: answered.status,
      headers: Object.fromEntries(
        KEPT_HEADERS.flatMap((name) =>
          answered.headers.has(name) ? [[name, answered.headers.get(name) ?? '']] : [],
        ),
      ),
      text,
    };
    return answered;
  };

  let expected: Fixture['expected'];
  let answer: ModelAnswer | undefined;
  try {
    answer = await provider
      .runner({ credential, fetch: recording })
      .run(step, new AbortController().signal);
    expected = { answer };
  } catch (error) {
    if (!(error instanceof ModelFailure)) throw error;
    expected = {
      failure: {
        kind: error.kind,
        retryable: error.retryable,
        ...(error.status === undefined ? {} : { status: error.status }),
      },
    };
    console.log(
      `  ${scenario}: failed as ${error.kind} (${String(error.status)}): ${error.message.slice(0, 160)}`,
    );
  }
  if (request === undefined || response === undefined)
    throw new Error(`${provider.id} ${scenario}: no call was made`);

  const fixture: Fixture = { provider: provider.id, scenario, step, request, response, expected };
  const written = `${JSON.stringify(fixture, null, 2)}\n`;
  for (const secret of secrets) {
    if (written.includes(secret))
      throw new Error(`${provider.id} ${scenario}: a key is in what would be written`);
  }
  const file = join(FIXTURES, provider.id, `${scenario}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, written);
  if (answer !== undefined) {
    const view = provider.read(answer.message);
    const calls = answer.toolCalls
      .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
      .join(', ');
    console.log(
      `  ${scenario}: ${answer.stopReason} | text ${JSON.stringify(view.text.slice(0, 80))} | calls [${calls}] | usage ${JSON.stringify(answer.usage)}`,
    );
  }
  return answer;
}

const given = process.argv.slice(2);
const only = given.filter((one) => !one.startsWith('--'));
const scenarios = given
  .filter((one) => one.startsWith('--scenario='))
  .map((one) => one.slice('--scenario='.length));
/** Whether a scenario is to be recorded now. */
const wanted = (scenario: string): boolean =>
  scenarios.length === 0 || scenarios.some((start) => scenario.startsWith(start));
const providers = builtInProviders();
const secrets = TARGETS.flatMap((target) =>
  process.env[target.env] === undefined ? [] : [process.env[target.env] as string],
);

for (const target of TARGETS) {
  const secret = process.env[target.env];
  if (secret === undefined || (only.length > 0 && !only.includes(target.provider))) continue;
  const provider = providers.get(target.provider);
  const credential = credentialOf(target.type, secret);
  const base = {
    model: target.model,
    reasoning: 'low',
    session: 'a-recorded-conversation',
  } as const;
  console.log(`${provider.label} (${target.model})`);

  await record(
    provider,
    'text',
    {
      ...base,
      instructions: 'Answer with exactly one word, in lowercase, and nothing else.',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say the word: pong' }] }],
    },
    credential,
    secrets,
  );

  const asking: ModelStep = {
    ...base,
    instructions:
      'You answer questions about orders. Look an order up before you say anything of it.',
    tools: [lookup],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What happened to order 4411?' }] }],
  };
  const called = await record(provider, 'tool-call', asking, credential, secrets);
  const call = called?.toolCalls[0];
  if (called !== undefined && call !== undefined) {
    await record(
      provider,
      'tool-result',
      {
        ...asking,
        messages: [
          ...asking.messages,
          called.message,
          {
            role: 'tool_result',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: 'Order 4411 was refunded twice, one second apart.' }],
            ...(call.resultOptions === undefined ? {} : { providerOptions: call.resultOptions }),
          },
        ],
      },
      credential,
      secrets,
    );
  }

  // A provider with a web search of its own: a search, and then its answer sent back as it was.
  if (target.search === true) {
    const searching: ModelStep = {
      ...base,
      instructions: 'Search the web once before you answer. Answer in one short sentence.',
      tools: [],
      options: provider.parseOptions({ webSearch: true }),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What does the page at example.com say it is for?' }],
        },
      ],
    };
    const searched = await record(provider, 'web-search', searching, credential, secrets);
    if (searched !== undefined) {
      await record(
        provider,
        'web-search-next',
        {
          ...searching,
          messages: [
            ...searching.messages,
            searched.message,
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Say that once more in other words. Do not search.' },
              ],
            },
          ],
        },
        credential,
        secrets,
      );
    }
  }

  // A provider that compacts a conversation itself: the compaction, and then the conversation
  // that goes on from it. The turns before it are made here and not kept: they are only what
  // there is to compact.
  if (provider.compacts !== undefined && wanted('compaction')) {
    const live = provider.runner({ credential });
    const signal = new AbortController().signal;
    const said = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
    // Thought about harder than the rest, so that the turns that are kept have reasoning in them.
    const thinking = { ...asking, reasoning: 'high' } as const;
    /** One exchange: a question, the call it leads to, the tool's result and the answer. */
    const exchange = async (
      before: readonly Message[],
      order: number,
      more = '',
    ): Promise<Message[]> => {
      const asked = said(`What happened to order ${String(order)}? Look it up.${more}`);
      const first = await live.run({ ...thinking, messages: [...before, asked] }, signal);
      const [made] = first.toolCalls;
      if (made === undefined) throw new Error(`${provider.id}: no call was made for the order`);
      const result: Message = {
        role: 'tool_result',
        toolCallId: made.id,
        toolName: made.name,
        content: [{ type: 'text', text: `Order ${String(order)} was refunded twice.` }],
        ...(made.resultOptions === undefined ? {} : { providerOptions: made.resultOptions }),
      };
      const second = await live.run(
        { ...thinking, messages: [...before, asked, first.message, result] },
        signal,
      );
      return [asked, first.message, result, second.message];
    };
    const older = await exchange([], 4411);
    // Something to think about, so that the answers that are kept have reasoning in them.
    const recent = await exchange(
      older,
      4412,
      ' Before you do, work out in your head which is larger, 17 * 23 + 19 * 31 or 29 * 29 + 11 * 13, and say which with your answer.',
    );
    const reasoned = recent.filter(
      (message) =>
        message.role === 'assistant' &&
        message.content.some((part) => /thinking|reasoning/.test(String(part['type']))),
    ).length;
    console.log(`  compaction: ${String(reasoned)} of the kept answers have reasoning in them`);
    // `older`: the older part is compacted, and the recent turns follow as they were.
    // `all`: all of it is, and what the user said is kept before what stands for it.
    const compacted = await record(
      provider,
      'compaction',
      {
        ...thinking,
        messages: provider.compacts === 'older' ? older : [...older, ...recent],
        compact: true,
      },
      credential,
      secrets,
    );
    const left = compacted === undefined ? undefined : provider.compacted?.(compacted.message);
    if (left === undefined) {
      console.log('  compaction: the answer holds nothing that stands for the conversation');
    } else {
      const users = [...older, ...recent].filter((message) => message.role === 'user');
      await record(
        provider,
        'compaction-next',
        {
          ...thinking,
          messages: [
            ...(provider.compacts === 'older' ? [left, ...recent] : [...users, left]),
            said('Say in one sentence what happened to both orders. Look nothing up.'),
          ],
        },
        credential,
        secrets,
      );
    }
  }

  await record(
    provider,
    'bad-key',
    {
      ...base,
      instructions: '',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
    },
    credentialOf(target.type, 'not-a-key'),
    secrets,
  );
  await record(
    provider,
    'unknown-model',
    {
      ...base,
      model: 'no-such-model',
      instructions: '',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
    },
    credential,
    secrets,
  );
}
