// The Anthropic adapter.

import { describe, expect, it } from 'vitest';

import { callProvider, LlmError } from '../src/client.js';
import type { LlmRequest } from '../src/client.js';
import { anthropic } from './fixtures.js';
import { anthropicBody, fakeFetch } from './fake.js';

const key = { apiKey: 'sk-ant-test' };

const request: LlmRequest<'anthropic'> = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  instructions: [
    { type: 'text', text: 'Be brief.', providerOptions: { cache_control: { type: 'ephemeral' } } },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix it.' }] }],
  options: { betas: ['compact-2026-01-12'], output_config: { effort: 'low' } },
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

describe('the Anthropic adapter', () => {
  it('sends the request as Anthropic takes it', async () => {
    const { fetch, sent } = fakeFetch(() => ({
      body: anthropicBody([{ type: 'text', text: 'ok' }]),
    }));
    await callProvider(request, { ...key, workspaceId: 'ws_1' }, { fetch });
    const [call] = sent;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(call?.headers.get('anthropic-workspace-id')).toBe('ws_1');
    expect(call?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call?.headers.get('anthropic-beta')).toBe('compact-2026-01-12');
    expect(call?.body).toEqual({
      output_config: { effort: 'low' },
      model: 'claude-sonnet-5-5',
      // Left out of the request, the model's own limit.
      max_tokens: 128_000,
      system: [{ cache_control: { type: 'ephemeral' }, type: 'text', text: 'Be brief.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix it.' }] }],
    });
  });

  it("leaves another model's thinking out, and sends the rest as written", async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: anthropicBody([]) }));
    await callProvider({ ...request, model: 'claude-opus-5-5', messages: [anthropic] }, key, {
      fetch,
    });
    const types = [
      'server_tool_use',
      'web_search_tool_result',
      'text',
      'text',
      'tool_use',
      'tool_use',
    ];
    expect(sent[0]?.body['messages']).toMatchObject([
      { role: 'assistant', content: types.map((type) => ({ type })) },
    ]);
  });

  it('sends a result, a plain text document and an image as Anthropic blocks', async () => {
    const { fetch, sent } = fakeFetch(() => ({ body: anthropicBody([]) }));
    const text = btoa('hello');
    await callProvider(
      {
        ...request,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                filename: 'notes.txt',
                source: { type: 'base64', mediaType: 'text/plain', data: text },
              },
              { type: 'image', source: { type: 'file_id', id: 'file_1' } },
            ],
          },
          {
            role: 'tool_result',
            toolCallId: 'toolu_1',
            toolName: 'read',
            content: [{ type: 'text', text: 'x' }],
            isError: true,
          },
        ],
      },
      key,
      { fetch },
    );
    expect(sent[0]?.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'hello' },
            title: 'notes.txt',
          },
          { type: 'image', source: { type: 'file', file_id: 'file_1' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x', is_error: true }],
      },
    ]);
  });

  it('reads the answer: stop reason, usage with cache reads, and cost', async () => {
    const { fetch } = fakeFetch(() => ({
      body: anthropicBody([{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }], {
        stop_reason: 'tool_use',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 },
          service_tier: 'standard',
        },
      }),
    }));
    const response = await callProvider(request, key, { fetch });
    expect(response).toMatchObject({
      stopReason: 'tool_use',
      usage: { totalInput: 1300, input: 100, cacheRead: 1000, cacheWrite: 200, output: 50 },
      native: {
        usage: { cache_creation: { ephemeral_1h_input_tokens: 100 }, service_tier: 'standard' },
      },
    });
    expect(response).not.toHaveProperty('responseModel');
    // 100 at 2, 1000 at 0.1, 100 at 2.5, 100 at 4 and 50 at 10, per million.
    expect(response.usage?.cost?.total).toBeCloseTo(0.00145);
  });

  it('reads its errors: kind, the field at fault, and whether to retry', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      headers: { 'x-should-retry': 'false' },
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 205024 tokens > 200000 maximum',
        },
      },
    }));
    expect((await failure(callProvider(request, key, { fetch }))).toJSON()).toMatchObject({
      kind: 'context_overflow',
      retryable: false,
      providerType: 'invalid_request_error',
    });
    const field = fakeFetch(() => ({
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages.0.content: empty' },
      },
    }));
    expect(
      (await failure(callProvider(request, key, { fetch: field.fetch }))).failure.providerParam,
    ).toBe('messages.0.content');
  });

  it('refuses a custom tool, which Anthropic has none of', async () => {
    const { fetch } = fakeFetch(() => ({ body: anthropicBody([]) }));
    const custom: LlmRequest<'anthropic'> = {
      ...request,
      tools: [{ type: 'custom', name: 'patch', description: 'x' }],
    };
    expect((await failure(callProvider(custom, key, { fetch }))).message).toMatch(/custom tool/);
  });
});
