// The Responses adapter: OpenAI and Fireworks.

import { describe, expect, it } from 'vitest';

import { callProvider, LlmError, toolCalls, toolResult } from '../src/client.js';
import type { LlmRequest } from '../src/client.js';
import { openai } from './fixtures.js';
import { fakeFetch, responsesBody } from './fake.js';

const key = { apiKey: 'sk-test' };

const request: LlmRequest<'openai'> = {
  provider: 'openai',
  model: 'gpt-6.1-sol',
  instructions: 'Be brief.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Fix it.' }] },
    { role: 'system', content: [{ type: 'text', text: 'Mind the tests.' }] },
  ],
  tools: [
    {
      type: 'function',
      name: 'read',
      description: 'Reads a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  options: { reasoning: { effort: 'low' }, store: false },
};

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error('it did not fail');
}

describe('the Responses adapter', () => {
  it('sends the request as OpenAI takes it', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: responsesBody([]) }));
    await callProvider(request, { ...key, project: 'proj_1' }, { fetch });
    const [call] = sent;
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect(call?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(call?.headers.get('openai-project')).toBe('proj_1');
    expect(call?.body).toEqual({
      reasoning: { effort: 'low' },
      store: false,
      model: 'gpt-6.1-sol',
      instructions: 'Be brief.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it.' }] },
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Mind the tests.' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read',
          description: 'Reads a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
  });

  it('sends a reply back as it is, and a result as plain text with its call’s fields', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: responsesBody([]) }));
    const results = toolCalls(openai)
      .filter((call) => call.toolType !== 'native')
      .map((call) => toolResult(call, 'done'));
    await callProvider({ ...request, messages: [openai, ...results] }, key, { fetch });
    const input = sent[0]?.body['input'];
    expect(input).toContainEqual(openai.content[0]);
    expect(input).toContainEqual({
      caller: { type: 'program', caller_id: 'prog_1' },
      namespace: 'files',
      type: 'function_call_output',
      call_id: 'call_read',
      output: 'done',
    });
    expect(input).toContainEqual({
      type: 'custom_tool_call_output',
      call_id: 'call_patch',
      output: 'done',
    });
  });

  it('reads the answer: stop reason, usage, cost, and what is new in native', async () => {
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{}',
    };
    const { fetch } = fakeFetch(() => ({
      body: responsesBody([call], { model: 'gpt-6.1-sol-2026-09-01', service_tier: 'default' }),
    }));
    const response = await callProvider(request, key, { fetch });
    expect(response).toMatchObject({
      id: 'resp_1',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      responseModel: 'gpt-6.1-sol-2026-09-01',
      stopReason: 'tool_use',
      message: {
        role: 'assistant',
        provider: 'openai',
        api: 'openai-responses',
        model: 'gpt-6.1-sol',
        content: [call],
      },
      usage: { totalInput: 1000, input: 400, cacheRead: 600, output: 200, reasoning: 150 },
    });
    // 400 at 2, 600 at 0.1 and 200 at 10, per million.
    expect(response.usage?.cost?.total).toBeCloseTo(0.00286);
    expect(response.native).toEqual({ status: 'completed', service_tier: 'default' });
  });

  it('says why an incomplete response stopped', async () => {
    const { fetch } = fakeFetch(() => ({
      body: responsesBody([], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    }));
    const response = await callProvider(request, key, { fetch });
    expect(response.stopReason).toBe('length');
    expect(response.providerStopReason).toBe('max_output_tokens');
  });

  it('refuses what the request owns, streaming, and another provider’s messages', async () => {
    const { fetch } = fakeFetch(() => ({ body: responsesBody([]) }));
    const owned = {
      ...request,
      options: { ...request.options, model: 'x' },
    } as LlmRequest<'openai'>;
    expect((await failure(callProvider(owned, key, { fetch }))).message).toMatch(
      /options.model is set by the request/,
    );
    // Requests the types refuse, as a log or a gateway's caller may still send them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const streamed = { ...request, options: { stream: true } } as unknown as LlmRequest<'openai'>;
    expect((await failure(callProvider(streamed, key, { fetch }))).message).toMatch(
      /streaming is not supported/,
    );
    const fireworksReply = {
      role: 'assistant',
      provider: 'fireworks',
      api: 'openai-responses',
      model: 'm',
      content: [],
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const foreign = { ...request, messages: [fireworksReply] } as unknown as LlmRequest<'openai'>;
    expect((await failure(callProvider(foreign, key, { fetch }))).message).toMatch(
      /convert it before sending/,
    );
  });

  it('reads an HTTP error: its kind, code, field and when to retry', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '3' },
      body: {
        error: { message: 'Slow down', type: 'requests', code: 'rate_limit_exceeded', param: null },
      },
    }));
    const error = await failure(callProvider(request, key, { fetch }));
    expect(error.toJSON()).toMatchObject({
      name: 'LlmError',
      kind: 'rate_limited',
      retryable: true,
      provider: 'openai',
      httpStatus: 429,
      providerCode: 'rate_limit_exceeded',
      retryAfterMs: 3000,
      requestId: 'req_1',
    });
  });

  it('reads a failure that came with HTTP 200', async () => {
    const { fetch } = fakeFetch(() => ({
      body: responsesBody([], {
        status: 'failed',
        error: { code: 'context_length_exceeded', message: 'Too long' },
      }),
    }));
    const error = await failure(callProvider(request, key, { fetch }));
    expect(error.toJSON()).toMatchObject({
      kind: 'context_overflow',
      responseId: 'resp_1',
      usage: { output: 200 },
    });
  });
});

describe('Fireworks', () => {
  const fireworks: LlmRequest<'fireworks'> = {
    provider: 'fireworks',
    model: 'accounts/fireworks/models/kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  };

  it('sends to Fireworks, with system messages as system', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: responsesBody([]) }));
    const withSystem: LlmRequest<'fireworks'> = {
      ...fireworks,
      messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }],
    };
    await callProvider(withSystem, { apiKey: 'fw_1' }, { fetch });
    expect(sent[0]?.url).toBe('https://api.fireworks.ai/inference/v1/responses');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer fw_1');
    expect(sent[0]?.body['input']).toEqual([
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'x' }] },
    ]);
  });

  it('refuses a file, which Fireworks would drop without a word', async () => {
    const { fetch } = fakeFetch(() => ({ body: responsesBody([]) }));
    const withFile: LlmRequest<'fireworks'> = {
      ...fireworks,
      messages: [
        {
          role: 'user',
          content: [{ type: 'file', source: { type: 'url', url: 'https://x/a.pdf' } }],
        },
      ],
    };
    expect((await failure(callProvider(withFile, { apiKey: 'fw_1' }, { fetch }))).message).toMatch(
      /drop without a word/,
    );
  });

  it('reads its bare 404 for a lost previous response as not_found, naming the field', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 404,
      body: { detail: 'Previous response not found' },
    }));
    const error = await failure(callProvider(fireworks, { apiKey: 'fw_1' }, { fetch }));
    expect(error.toJSON()).toMatchObject({
      kind: 'not_found',
      providerParam: 'previous_response_id',
    });
  });

  it('estimates no cost for a tier whose prices are not known', async () => {
    const { fetch } = fakeFetch(() => ({ body: responsesBody([]) }));
    const standard = await callProvider(fireworks, { apiKey: 'fw_1' }, { fetch });
    expect(standard.usage?.cost?.source).toBe('estimated');
    const priority = await callProvider(
      { ...fireworks, options: { service_tier: 'priority' } },
      { apiKey: 'fw_1' },
      { fetch },
    );
    expect(priority.usage).toBeDefined();
    expect(priority.usage?.cost).toBeUndefined();
  });
});
