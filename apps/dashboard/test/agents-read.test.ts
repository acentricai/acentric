// Reading what an actor's conversation holds, as its page draws it: a notice's text, an
// image's source (and none for one that may carry script), the searches of the provider's own
// web search, and a model's answer in each provider's format.

import type { ContentPart, Message } from '@acentric/protocol';
import { describe, expect, it } from 'vitest';

import { blobUrl } from '../src/agents/api.ts';
import { imageSource, messageText, readResponse } from '../src/agents/log/read.ts';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const notice = {
  role: 'system',
  content: [
    { type: 'text', text: '<task id="s1" kind="code" status="done" ran="3s">\nlook\n' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXEL } },
    { type: 'text', text: '\nshown\n</task>' },
  ],
} as unknown as Message;

describe('a notice with an image', () => {
  it('reads as its text', () => {
    expect(messageText(notice)).toBe(
      '<task id="s1" kind="code" status="done" ran="3s">\nlook\n\n\nshown\n</task>',
    );
  });
});

describe('an image', () => {
  const blob = (digest: string) => blobUrl('act_9', digest);
  const kept = (mediaType: string) =>
    ({
      type: 'image',
      source: { type: 'blob', digest: 'a'.repeat(64), mediaType, size: 10 },
    }) as unknown as ContentPart;

  it('is shown from what the message carries, or from the actor’s blobs on the server', () => {
    const carried = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: PIXEL },
    } as unknown as ContentPart;
    expect(imageSource(carried, blob)).toBe(`data:image/png;base64,${PIXEL}`);
    expect(imageSource(kept('image/png'), blob)).toBe(`/v1/actors/act_9/blobs/${'a'.repeat(64)}`);
  });

  it('is not shown when it may carry script', () => {
    expect(imageSource(kept('image/svg+xml'), blob)).toBeNull();
    const svg = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/svg+xml', data: PIXEL },
    } as unknown as ContentPart;
    expect(imageSource(svg, blob)).toBeNull();
  });
});

const answer = (provider: string, content: object[]) =>
  ({
    role: 'assistant',
    provider,
    api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
    model: 'm',
    content,
  }) as never;

describe('an answer that searched the web', () => {
  it('names what it searched, on Anthropic and on OpenAI', () => {
    const anthropic = answer('anthropic', [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'node release' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'text', text: 'Node 26.' },
    ]);
    expect(readResponse(anthropic).searches).toEqual(['node release']);

    const openai = answer('openai', [
      {
        type: 'web_search_call',
        id: 'ws1',
        status: 'completed',
        action: { type: 'search', queries: ['node lts'] },
      },
      {
        type: 'web_search_call',
        id: 'ws2',
        status: 'completed',
        action: { type: 'open_page', url: 'https://nodejs.org/' },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Node 26.', annotations: [] }],
      },
    ]);
    expect(readResponse(openai).searches).toEqual(['node lts', 'https://nodejs.org/']);
  });
});

describe('reading an answer', () => {
  it('reads what it says, its reasoning, its refusals and its calls, in the Responses format', () => {
    const view = readResponse(
      answer('openai', [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look it up.' }] },
        {
          type: 'message',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Looking…' }],
        },
        { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
        { type: 'message', content: [{ type: 'refusal', refusal: 'Not that.' }] },
        { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"id":4}' },
        { type: 'function_call', call_id: 'c2', name: 'raw', arguments: 'not json' },
      ]),
    );
    expect(view).toEqual({
      text: 'Done.',
      thinking: ['Look it up.'],
      refusals: ['Not that.'],
      calls: [
        { toolCallId: 'c1', toolName: 'lookup', arguments: { id: 4 } },
        { toolCallId: 'c2', toolName: 'raw', arguments: 'not json' },
      ],
      searches: [],
    });
  });

  it('reads Anthropic’s text, thinking and tool uses', () => {
    const view = readResponse(
      answer('anthropic', [
        { type: 'thinking', thinking: 'Hm.', signature: 's' },
        { type: 'text', text: 'One ' },
        { type: 'text', text: 'two.' },
        { type: 'tool_use', id: 't1', name: 'lookup', input: { id: 4 } },
      ]),
    );
    expect(view).toEqual({
      text: 'One two.',
      thinking: ['Hm.'],
      refusals: [],
      calls: [{ toolCallId: 't1', toolName: 'lookup', arguments: { id: 4 } }],
      searches: [],
    });
  });
});
