// What each provider does that the recordings do not show: what it sends for what an agent
// asks of it, what it refuses before it calls, and what it makes of each way a call fails.

import { describe, expect, it } from 'vitest';

import type { AssistantMessage, Message } from '@acentric/protocol';

import {
  ModelFailure,
  Providers,
  UnknownProvider,
  bindsReasoning,
  builtInProviders,
  effortOf,
  estimateCost,
} from '../src/index.ts';
import type { ModelStep } from '../src/index.ts';
import { retryAfter } from '../src/http.ts';
import { answering, credentialFor, fixture } from './replay.ts';

const providers = builtInProviders();
const signal = () => new AbortController().signal;

const step = (more: Partial<ModelStep> = {}): ModelStep => ({
  model: 'a-model',
  reasoning: 'medium',
  instructions: 'You answer questions about orders.',
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
  ...more,
});

/** What a provider sends for a step, answered with what was recorded for `text`. */
async function sentBy(id: string, given: ModelStep) {
  const { fetch, sent } = answering(fixture(id, 'text').response);
  await providers
    .get(id)
    .runner({ credential: credentialFor(id), fetch })
    .run(given, signal());
  return sent[0] as (typeof sent)[number];
}

/** How a provider fails for an answer of `status` and `body`. */
async function failureOf(
  id: string,
  status: number,
  body: unknown,
  headers: { [name: string]: string } = {},
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const { fetch } = answering({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    text,
  });
  try {
    await providers
      .get(id)
      .runner({ credential: credentialFor(id), fetch })
      .run(step(), signal());
  } catch (error) {
    return error as ModelFailure;
  }
  throw new Error('The call did not fail');
}

describe('the instructions', () => {
  it('go first in the input for OpenAI and ChatGPT, where what was read of them is kept', async () => {
    for (const id of ['openai', 'chatgpt']) {
      const { body } = await sentBy(id, step());
      expect(body['instructions'], id).toBeUndefined();
      expect((body['input'] as unknown[])[0], id).toEqual({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'You answer questions about orders.' }],
      });
    }
  });

  it('are a field of their own for Fireworks', async () => {
    const { body } = await sentBy('fireworks', step());
    expect(body['instructions']).toBe('You answer questions about orders.');
    expect(body['input']).toHaveLength(1);
  });

  it('are the system for Anthropic, with a mark to keep them by', async () => {
    const { body } = await sentBy('anthropic', step());
    expect(body['system']).toEqual([
      {
        type: 'text',
        text: 'You answer questions about orders.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('are left out when there are none', async () => {
    expect((await sentBy('anthropic', step({ instructions: '' }))).body['system']).toBeUndefined();
    expect((await sentBy('openai', step({ instructions: '' }))).body['input']).toHaveLength(1);
  });
});

describe('the reasoning level', () => {
  it('is sent as itself where the model takes it', async () => {
    expect((await sentBy('openai', step({ reasoning: 'xhigh' }))).body['reasoning']).toMatchObject({
      effort: 'xhigh',
    });
    expect((await sentBy('anthropic', step({ reasoning: 'max' }))).body['output_config']).toEqual({
      effort: 'max',
    });
  });

  it('is moved to the nearest the model takes, the higher of two as near', async () => {
    const fireworks = async (model: string, reasoning: ModelStep['reasoning']) =>
      (
        (await sentBy('fireworks', step({ model, reasoning }))).body['reasoning'] as {
          effort: string;
        }
      ).effort;
    expect(await fireworks('accounts/fireworks/models/kimi-k3p1-pro', 'medium')).toBe('high');
    expect(await fireworks('accounts/fireworks/models/kimi-k3p1-pro', 'xhigh')).toBe('max');
    expect(await fireworks('accounts/fireworks/models/deepseek-v4p1-flash-1017', 'xhigh')).toBe(
      'high',
    );
    expect(effortOf({ low: 'l', max: 'm' }, 'high')).toBe('m');
    expect(effortOf({ low: 'l', max: 'm' }, 'medium')).toBe('l');
  });
});

describe('what names the conversation', () => {
  it('is sent as the key the provider keeps what it has read by', async () => {
    for (const id of ['openai', 'chatgpt', 'fireworks']) {
      expect((await sentBy(id, step({ session: 'act_1' }))).body['prompt_cache_key'], id).toBe(
        'act_1',
      );
      expect((await sentBy(id, step())).body['prompt_cache_key'], id).toBeUndefined();
    }
  });
});

describe('the provider’s own web search', () => {
  it('is a tool of OpenAI’s, for the sites asked for', async () => {
    const openai = providers.get('openai');
    const all = await sentBy('openai', step({ options: openai.parseOptions({ webSearch: true }) }));
    expect(all.body['tools']).toEqual([{ type: 'web_search', external_web_access: true }]);
    const some = await sentBy(
      'openai',
      step({ options: openai.parseOptions({ webSearch: { allowedDomains: ['example.com'] } }) }),
    );
    expect(some.body['tools']).toEqual([
      {
        type: 'web_search',
        external_web_access: true,
        filters: { allowed_domains: ['example.com'] },
      },
    ]);
  });

  it('is a tool of Anthropic’s', async () => {
    const options = providers
      .get('anthropic')
      .parseOptions({ webSearch: { blockedDomains: ['example.com'] } });
    const { body } = await sentBy('anthropic', step({ options }));
    expect(body['tools']).toEqual([
      {
        type: 'web_search_20260318',
        name: 'web_search',
        allowed_callers: ['direct'],
        blocked_domains: ['example.com'],
      },
    ]);
  });

  it('is refused where the provider has none, and when it is asked for wrongly', () => {
    expect(() => providers.get('fireworks').parseOptions({ webSearch: true })).toThrow(
      /Fireworks has no webSearch/,
    );
    const openai = providers.get('openai');
    expect(() => openai.parseOptions({ webSearch: { allowedDomains: [] } })).toThrow(
      /webSearch is true/,
    );
    // A domain is given without its scheme, and no more than a hundred of them.
    for (const allowedDomains of [
      ['https://example.com'],
      ['example.com:8080'],
      ['two words.com'],
      Array.from({ length: 101 }, (_, index) => `site${String(index)}.example`),
    ]) {
      expect(() => openai.parseOptions({ webSearch: { allowedDomains } })).toThrow(
        /webSearch\.allowedDomains is a list of 1 to 100 domains, such as example\.com, with no https:\/\//,
      );
    }
    expect(() =>
      openai.parseOptions({ webSearch: { blockedDomains: ['http://example.com'] } }),
    ).toThrow(/webSearch\.blockedDomains is a list of 1 to 100 domains/);
    expect(
      openai.parseOptions({
        webSearch: { allowedDomains: ['example.com', 'docs.example.com/guides'] },
      }),
    ).toBeDefined();
    expect(() =>
      openai.parseOptions({ webSearch: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] } }),
    ).toThrow(/webSearch is true/);
    expect(() => openai.parseOptions({ temperature: 2 })).toThrow(/OpenAI has no temperature/);
    expect(openai.parseOptions(undefined)).toEqual({});
  });
});

describe('ChatGPT', () => {
  it('asks for a stream, keeps nothing, and signs with the token of who signed in', async () => {
    const { body, headers } = await sentBy('chatgpt', step());
    expect(body).toMatchObject({ stream: true, store: false });
    expect(headers).toMatchObject({ authorization: '<redacted>', accept: 'text/event-stream' });
  });

  it('is not called with an API key, nor OpenAI with a token', () => {
    const key = { type: 'api_key', apiKey: 'k' } as const;
    const token = { type: 'access_token', accessToken: 't' } as const;
    const { fetch } = answering(fixture('chatgpt', 'text').response);
    const call = (id: string, credential: typeof key | typeof token) =>
      providers.get(id).runner({ credential, fetch }).run(step(), signal());
    return Promise.all([
      expect(call('chatgpt', key)).rejects.toThrow(/signed in with ChatGPT/),
      expect(call('openai', token)).rejects.toThrow(/API key/),
    ]);
  });

  it('says when the plan has no more to give', async () => {
    const failure = await failureOf('chatgpt', 429, {
      error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
    });
    expect(failure).toMatchObject({ kind: 'quota_exceeded', retryable: false });
    expect(failure.message).toMatch(/plan's limit is reached/);
  });
});

describe('what a conversation holds', () => {
  const assistant = (provider: string, api: string): Message => ({
    role: 'assistant',
    provider,
    api,
    model: 'a-model',
    content: [{ type: 'text', text: 'Hi.' }],
  });

  it('an answer of another provider is refused before any call is made', async () => {
    for (const [id, other] of [
      ['openai', assistant('anthropic', 'anthropic-messages')],
      ['anthropic', assistant('openai', 'openai-responses')],
      // The same models, and not the same provider: one's answers are not the other's to send.
      ['chatgpt', assistant('openai', 'openai-responses')],
    ] as const) {
      const { fetch, sent } = answering(fixture(id, 'text').response);
      const run = providers
        .get(id)
        .runner({ credential: credentialFor(id), fetch })
        .run(step({ messages: [...step().messages, other] }), signal());
      await expect(run, id).rejects.toMatchObject({
        name: 'ModelFailure',
        kind: 'invalid_request',
        retryable: false,
      });
      expect(sent, id).toEqual([]);
    }
  });

  it('a file is sent where it is read, and refused where it would be dropped', async () => {
    const file: Message = {
      role: 'user',
      content: [
        {
          type: 'file',
          source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
          filename: 'a.pdf',
        },
      ],
    };
    const openai = await sentBy('openai', step({ instructions: '', messages: [file] }));
    expect(openai.body['input']).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,JVBERi0=',
            filename: 'a.pdf',
          },
        ],
      },
    ]);
    const anthropic = await sentBy('anthropic', step({ messages: [file] }));
    expect(anthropic.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
            title: 'a.pdf',
          },
        ],
      },
    ]);
    await expect(sentBy('fireworks', step({ messages: [file] }))).rejects.toMatchObject({
      kind: 'invalid_request',
    });
  });

  it('an image goes as a URL, or as its data', async () => {
    const image: Message = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    };
    const openai = await sentBy('openai', step({ instructions: '', messages: [image] }));
    expect(openai.body['input']).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.com/a.png' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        ],
      },
    ]);
    const anthropic = await sentBy('anthropic', step({ messages: [image] }));
    expect(anthropic.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
          },
        ],
      },
    ]);
  });

  it('the application’s own entries are sent to no provider', async () => {
    const own: Message = { role: 'custom', tag: 'note', data: { by: 'the engine' } };
    for (const id of ['openai', 'anthropic']) {
      const { body } = await sentBy(
        id,
        step({ instructions: '', messages: [...step().messages, own] }),
      );
      expect((body['input'] ?? body['messages']) as unknown[], id).toHaveLength(1);
    }
  });

  it('a tool’s result is sent as its text when it is one piece of text, and as its parts otherwise', async () => {
    const result = (content: Extract<Message, { role: 'tool_result' }>['content']): Message => ({
      role: 'tool_result',
      toolCallId: 'c1',
      toolName: 'lookup_order',
      content,
    });
    const text = { type: 'text', text: 'one' } as const;
    const outputs = async (id: string, content: Parameters<typeof result>[0]) => {
      const { body } = await sentBy(id, step({ instructions: '', messages: [result(content)] }));
      const [item] = (body['input'] ?? body['messages']) as {
        output?: unknown;
        content?: { content: unknown }[];
      }[];
      return item?.output ?? item?.content?.[0]?.content;
    };
    for (const id of ['openai', 'anthropic']) {
      expect(await outputs(id, [text]), id).toBe('one');
      expect(await outputs(id, []), id).toEqual([]);
      expect(await outputs(id, [text, text]), id).toHaveLength(2);
    }
  });

  it('a tool’s result that failed says so where the provider has a word for it', async () => {
    const result: Message = {
      role: 'tool_result',
      toolCallId: 'c1',
      toolName: 'lookup_order',
      content: [{ type: 'text', text: 'There is no such order.' }],
      isError: true,
      providerOptions: { caller: { type: 'direct' } },
    };
    const anthropic = await sentBy('anthropic', step({ messages: [result] }));
    expect(anthropic.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          {
            caller: { type: 'direct' },
            type: 'tool_result',
            tool_use_id: 'c1',
            content: 'There is no such order.',
            is_error: true,
          },
        ],
      },
    ]);
    const openai = await sentBy('openai', step({ instructions: '', messages: [result] }));
    expect(openai.body['input']).toEqual([
      {
        caller: { type: 'direct' },
        type: 'function_call_output',
        call_id: 'c1',
        output: 'There is no such order.',
      },
    ]);
  });
});

describe('reasoning from before a change', () => {
  const answer = (
    provider: string,
    api: string,
    content: AssistantMessage['content'],
  ): AssistantMessage => ({
    role: 'assistant',
    provider,
    api,
    model: 'a-model',
    content,
  });

  it('is tied to what came before it for the models that say so, and for those not known', () => {
    const binds = (id: string, model: string) => bindsReasoning(providers.get(id), model);
    expect(binds('anthropic', 'claude-fable-5-2')).toBe(true);
    expect(binds('anthropic', 'claude-sonnet-5-5')).toBe(true);
    expect(binds('openai', 'gpt-6.2-sol')).toBe(true);
    expect(binds('chatgpt', 'gpt-6.2-astra')).toBe(true);
    expect(binds('openai', 'gpt-6.1-terra')).toBe(false);
    expect(binds('openai', 'gpt-6-luna')).toBe(false);
    expect(binds('fireworks', 'accounts/fireworks/models/glm-5p3-flash')).toBe(false);
    // A model the catalog has not heard of is a newer one.
    expect(binds('anthropic', 'claude-next')).toBe(true);
    expect(binds('openai', 'gpt-7')).toBe(true);
    expect(binds('fireworks', 'accounts/fireworks/models/new')).toBe(false);
  });

  it('is taken out of an answer, and everything else of the answer stays', () => {
    const thought = answer('anthropic', 'anthropic-messages', [
      { type: 'thinking', thinking: 'Look it up.', signature: 'sig' },
      { type: 'redacted_thinking', data: 'sealed' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup_order', input: { id: 4411 } },
    ]);
    expect(
      providers
        .get('anthropic')
        .withoutReasoning(thought)
        .content.map((block) => block['type']),
    ).toEqual(['text', 'tool_use']);

    const reasoned = answer('openai', 'openai-responses', [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed', summary: [] },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup_order',
        arguments: '{}',
      },
    ]);
    for (const id of ['openai', 'chatgpt', 'fireworks']) {
      const kept = providers.get(id).withoutReasoning(reasoned);
      expect(
        kept.content.map((item) => item['type']),
        id,
      ).toEqual(['function_call']);
    }
    // An answer with none is the answer itself: nothing is copied.
    const plain = answer('openai', 'openai-responses', [{ type: 'message', id: 'msg_1' }]);
    expect(providers.get('openai').withoutReasoning(plain)).toBe(plain);
  });

  it('an answer that was thinking and nothing else is not sent to Anthropic at all', async () => {
    const only = answer('anthropic', 'anthropic-messages', []);
    const sent = await sentBy(
      'anthropic',
      step({
        messages: [
          ...step().messages,
          only,
          { role: 'user', content: [{ type: 'text', text: 'Go on.' }] },
        ],
      }),
    );
    const roles = (sent.body['messages'] as { role: string }[]).map((message) => message.role);
    expect(roles).toEqual(['user', 'user']);
  });
});

describe('a reasoning level changed in the middle of a conversation', () => {
  it('is a message of the provider’s own, where it has one, and nothing where it has not', () => {
    expect(providers.get('anthropic').reasoningChange?.('claude-opus-5-5', 'high')).toEqual({
      role: 'system',
      content: [],
      providerOptions: { output_config: { effort: 'high' } },
    });
    for (const id of ['openai', 'chatgpt']) {
      expect(providers.get(id).reasoningChange?.('gpt-6.2-sol', 'low'), id).toEqual({
        role: 'native',
        provider: id,
        api: 'openai-responses',
        content: [{ type: 'configuration_update', reasoning: { effort: 'low' } }],
      });
    }
    // It takes a level only with a call.
    expect(providers.get('fireworks').reasoningChange).toBeUndefined();
  });

  it('is sent where it is in the conversation, and the call’s own level stays', async () => {
    const hello = step().messages;
    const change = (id: string) =>
      providers.get(id).reasoningChange?.('a-model', 'high') as Message;

    const toOpenAi = await sentBy('openai', step({ messages: [...hello, change('openai')] }));
    expect((toOpenAi.body['input'] as unknown[]).at(-1)).toEqual({
      type: 'configuration_update',
      reasoning: { effort: 'high' },
    });
    expect(toOpenAi.body['reasoning']).toMatchObject({ effort: 'medium' });

    const toAnthropic = await sentBy(
      'anthropic',
      step({ messages: [...hello, change('anthropic')] }),
    );
    expect((toAnthropic.body['messages'] as unknown[]).at(-1)).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    });
    expect(toAnthropic.body['output_config']).toEqual({ effort: 'medium' });
    // Anthropic takes it as a beta, which a request that has one names, and no other does.
    expect(toAnthropic.headers['anthropic-beta']).toBe('mid-conversation-output-config-2026-07-01');
    expect((await sentBy('anthropic', step())).headers['anthropic-beta']).toBeUndefined();
  });
});

describe('a call that fails', () => {
  it('for too many calls may pass later, after as long as the provider says', async () => {
    const openai = await failureOf(
      'openai',
      429,
      { error: { code: 'rate_limit_exceeded', message: 'Slow down' } },
      { 'retry-after': '7' },
    );
    expect(openai).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 7000,
      status: 429,
    });
    const anthropic = await failureOf(
      'anthropic',
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } },
      { 'retry-after-ms': '1500' },
    );
    expect(anthropic).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 1500 });
  });

  it('because the provider is overloaded, or failed, may pass later', async () => {
    expect(
      await failureOf('anthropic', 529, {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    ).toMatchObject({
      kind: 'overloaded',
      retryable: true,
    });
    expect(
      await failureOf('openai', 500, { error: { code: 'server_error', message: 'Oops' } }),
    ).toMatchObject({
      kind: 'provider_error',
      retryable: true,
    });
    expect(await failureOf('fireworks', 503, 'upstream connect error')).toMatchObject({
      kind: 'overloaded',
      retryable: true,
      message: 'upstream connect error',
    });
  });

  it('is read by its status alone when its body says nothing a provider knows', async () => {
    const kinds: [number, string, boolean][] = [
      [401, 'auth', false],
      [403, 'auth', false],
      [404, 'not_found', false],
      [408, 'timeout', true],
      [429, 'rate_limited', true],
      [500, 'provider_error', true],
      [503, 'overloaded', true],
      [504, 'timeout', true],
      [418, 'invalid_request', false],
    ];
    for (const id of ['openai', 'chatgpt', 'fireworks', 'anthropic']) {
      for (const [status, kind, retryable] of kinds) {
        expect(
          await failureOf(id, status, 'something went wrong'),
          `${id} ${String(status)}`,
        ).toMatchObject({
          kind,
          retryable,
          status,
          provider: id,
        });
      }
    }
  });

  it('is not tried again when the provider says not to, whatever its kind', async () => {
    const failure = await failureOf(
      'anthropic',
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      { 'x-should-retry': 'false' },
    );
    expect(failure).toMatchObject({ kind: 'overloaded', retryable: false });
  });

  it('for a conversation too long is that, and will not pass', async () => {
    const cases: [string, number, unknown][] = [
      ['openai', 400, { error: { code: 'context_length_exceeded', message: 'Too long' } }],
      [
        'openai',
        400,
        { error: { message: 'This request exceeds the context window of the model.' } },
      ],
      [
        'anthropic',
        400,
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 205024 tokens > 200000 maximum',
          },
        },
      ],
      ['anthropic', 413, 'Request Entity Too Large'],
      ['fireworks', 400, { detail: 'The prompt is too long for this model' }],
    ];
    for (const [id, status, body] of cases) {
      expect(await failureOf(id, status, body), `${id} ${String(status)}`).toMatchObject({
        kind: 'context_overflow',
        retryable: false,
      });
    }
  });

  it('for reasoning tied to what has since changed is that, whatever else was wrong', async () => {
    // As Anthropic answered a conversation whose instructions were changed, on 2026-11-22.
    const failure = await failureOf('anthropic', 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". The `system` prompt differs',
      },
    });
    // The same call is refused again: it is the engine that sends it without that reasoning.
    expect(failure).toMatchObject({ kind: 'stale_reasoning', retryable: false });
  });

  it('for an account with no more to spend is that', async () => {
    expect(
      await failureOf('openai', 429, {
        error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'No credit' },
      }),
    ).toMatchObject({
      kind: 'quota_exceeded',
      retryable: false,
    });
    expect(
      await failureOf('anthropic', 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your credit balance is too low' },
      }),
    ).toMatchObject({
      kind: 'quota_exceeded',
    });
    expect(
      await failureOf('fireworks', 402, { error: { message: 'Payment required' } }),
    ).toMatchObject({ kind: 'quota_exceeded' });
  });

  it('says what a server wrote of a request it would not take', async () => {
    const failure = await failureOf('fireworks', 422, {
      detail: [{ loc: ['body', 'reasoning', 'effort'], msg: 'Input should be low, high or max' }],
    });
    expect(failure).toMatchObject({
      kind: 'invalid_request',
      message: 'reasoning.effort: Input should be low, high or max',
    });
  });

  it('with a response that failed, though it came with HTTP 200', async () => {
    const failed = await failureOf('openai', 200, {
      object: 'response',
      status: 'failed',
      error: { code: 'server_error', message: 'Oops' },
    });
    expect(failed).toMatchObject({ kind: 'provider_error', retryable: true });
    const invalid = await failureOf('openai', 200, { hello: 'there' });
    expect(invalid).toMatchObject({ kind: 'invalid_response', retryable: false });
  });

  it('with a stream that ended before its answer did is worth making again', async () => {
    const whole = fixture('anthropic', 'text').response.text;
    const cut = whole.slice(0, whole.indexOf('event: message_delta'));
    expect(await failureOf('anthropic', 200, cut)).toMatchObject({
      kind: 'invalid_response',
      retryable: true,
    });
    const stream = fixture('chatgpt', 'text').response.text;
    const short = stream.slice(0, stream.indexOf('event: response.completed'));
    expect(await failureOf('chatgpt', 200, short)).toMatchObject({
      kind: 'invalid_response',
      retryable: true,
    });
  });

  it('with an error in the middle of a stream is the failure that error says', async () => {
    const stream =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    expect(await failureOf('anthropic', 200, stream)).toMatchObject({
      kind: 'overloaded',
      retryable: true,
    });
  });

  it('because it did not get through may pass later', async () => {
    const runner = providers.get('openai').runner({
      credential: credentialFor('openai'),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(runner.run(step(), signal())).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('is not a failure of the call when whoever asked for it stopped it', async () => {
    const stop = new AbortController();
    const runner = providers.get('anthropic').runner({
      credential: credentialFor('anthropic'),
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const run = runner.run(step(), stop.signal);
    stop.abort(new Error('interrupted'));
    await expect(run).rejects.toThrow('interrupted');
    await expect(run).rejects.not.toBeInstanceOf(ModelFailure);
  });
});

describe('how long to wait', () => {
  it('is read from what the provider says, in seconds, in milliseconds or as a time', () => {
    expect(retryAfter(new Headers({ 'retry-after': '2.5' }))).toBe(2500);
    expect(retryAfter(new Headers({ 'retry-after-ms': '750', 'retry-after': '9' }))).toBe(750);
    expect(
      retryAfter(new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() })),
    ).toBeGreaterThan(50_000);
    expect(retryAfter(new Headers())).toBeUndefined();
    expect(retryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
  });
});

describe('what a call cost', () => {
  const pricing = {
    base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    tiers: [
      { aboveInputTokens: 1000, cost: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 } },
    ],
  };

  it('is each part at its price', () => {
    const cost = estimateCost(
      { totalInput: 1000, input: 600, cacheRead: 300, cacheWrite: 100, output: 200 },
      pricing,
    );
    expect(cost).toEqual({
      source: 'estimated',
      input: 0.0012,
      output: 0.002,
      cacheRead: 0.00006,
      cacheWrite: 0.00025,
      total: 0.0012 + 0.002 + 0.00006 + 0.00025,
    });
  });

  it('is at the prices of the tier the prompt is over, for the whole request', () => {
    const cost = estimateCost(
      { totalInput: 1001, input: 1001, cacheRead: 0, cacheWrite: 0, output: 100 },
      pricing,
    );
    expect(cost).toMatchObject({ input: 0.004004, output: 0.0015 });
  });

  it('is not known without prices, without a count, or for tokens that have no price', () => {
    expect(estimateCost({ totalInput: 10, input: 10, output: 1 }, undefined)).toBeUndefined();
    expect(estimateCost({ totalInput: 10, output: 1 }, pricing)).toBeUndefined();
    expect(
      estimateCost(
        { totalInput: 10, input: 5, cacheRead: 5, output: 1 },
        { base: { input: 1, output: 1 } },
      ),
    ).toBeUndefined();
  });
});

describe('the providers an engine has', () => {
  it('are found by what an agent calls them', () => {
    expect(providers.list().map((provider) => provider.id)).toEqual([
      'openai',
      'chatgpt',
      'fireworks',
      'anthropic',
    ]);
    expect(providers.get('anthropic').label).toBe('Anthropic');
    expect(() => providers.get('claude')).toThrow(UnknownProvider);
    expect(() => providers.get('claude')).toThrow(
      /there are openai, chatgpt, fireworks, anthropic/,
    );
  });

  it('take another, once', () => {
    const more = new Providers([providers.get('openai')]);
    const mine = { ...providers.get('openai'), id: 'my-provider' };
    expect(more.add(mine).has('my-provider')).toBe(true);
    expect(() => more.add(mine)).toThrow(/already/);
  });

  it('call Anthropic where they are told its API is, for tests, and at its own without', async () => {
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      asked.push(String(input));
      return new Response('{"data":[]}', { status: 200 });
    };
    const credential = { type: 'api_key' as const, apiKey: 'a-test-key' };
    const elsewhere = builtInProviders({ anthropicUrl: 'http://127.0.0.1:9998/' });
    await elsewhere.get('anthropic').check?.({ credential, fetch });
    await providers.get('anthropic').check?.({ credential, fetch });
    expect(asked).toEqual([
      'http://127.0.0.1:9998/v1/models?limit=1',
      'https://api.anthropic.com/v1/models?limit=1',
    ]);
    const { fetch: answered, sent } = answering(fixture('anthropic', 'text').response);
    await elsewhere.get('anthropic').runner({ credential, fetch: answered }).run(step(), signal());
    expect(sent[0]?.url).toBe('http://127.0.0.1:9998/v1/messages');
  });

  it('each have a default model that is one of its own', () => {
    for (const provider of providers.list()) {
      expect(
        provider.models.map((model) => model.id),
        provider.id,
      ).toContain(provider.defaultModel);
    }
  });
});

describe('a step that asks for a compaction', () => {
  it('is a request for a summary at Anthropic, under the beta it has, and the block it left is sent under it', async () => {
    const asked = await sentBy('anthropic', step({ compact: true }));
    expect(asked.body).toMatchObject({ compaction: { type: 'summarize' } });
    expect(asked.headers['anthropic-beta']).toBe('compact-2026-09-04');
    const plain = await sentBy('anthropic', step());
    expect(plain.body).not.toHaveProperty('compaction');
    expect(plain.headers['anthropic-beta']).toBeUndefined();

    // A conversation that starts with what a compaction left names the beta, whatever it asks.
    const block = { type: 'compaction', content: 'They asked about orders.', signature: 's' };
    const left = {
      role: 'assistant' as const,
      provider: 'anthropic',
      api: 'anthropic-messages',
      model: 'claude-opus-5-5',
      content: [block],
    };
    const after = await sentBy(
      'anthropic',
      step({
        messages: [left, { role: 'user', content: [{ type: 'text', text: 'And order 7?' }] }],
      }),
    );
    expect(after.headers['anthropic-beta']).toBe('compact-2026-09-04');
    expect((after.body['messages'] as { content: unknown }[])[0]?.content).toEqual([block]);
    expect(providers.get('anthropic').compacted?.(left as never)?.content).toEqual([block]);
    // Not one, when it holds two, or none.
    expect(
      providers.get('anthropic').compacted?.({ ...left, content: [block, block] } as never),
    ).toBeUndefined();
  });

  it('is an item that ends the input at OpenAI and on a ChatGPT plan, and nothing at a provider that has none', async () => {
    for (const id of ['openai', 'chatgpt']) {
      const asked = await sentBy(id, step({ compact: true }));
      expect((asked.body['input'] as unknown[]).at(-1)).toEqual({ type: 'compaction_trigger' });
      expect(JSON.stringify((await sentBy(id, step())).body)).not.toContain('compaction_trigger');
      expect(providers.get(id).compacts).toBe('all');
    }
    expect(providers.get('anthropic').compacts).toBe('older');
    // Fireworks has none: its model writes a summary, asked as it is asked anything.
    expect(providers.get('fireworks').compacts).toBeUndefined();
    expect(providers.get('fireworks').compacted).toBeUndefined();
    expect(JSON.stringify((await sentBy('fireworks', step({ compact: true }))).body)).not.toContain(
      'compaction',
    );
  });
});
