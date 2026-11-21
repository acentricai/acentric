import { describe, expect, it } from 'vitest';

import { contentPartSchema } from '../src/content.ts';
import { messageSchema, toolDefinitionSchema, usageSchema } from '../src/messages.ts';
import type { Message } from '../src/messages.ts';

const text = (value: string) => ({ type: 'text' as const, text: value });

/** One message of every role, each with what only it has. */
const MESSAGES: readonly Message[] = [
  {
    role: 'user',
    content: [text('Why was order 4411 refunded twice?')],
    timestamp: 1_795_305_600_000,
  },
  { role: 'system', content: [text('Answer in French from here on.')] },
  {
    role: 'assistant',
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: 'claude-opus-5-5',
    // The provider's own items: nothing here reads them.
    content: [
      { type: 'thinking', thinking: 'The audit log has it.', signature: 'c2ln' },
      { type: 'tool_use', id: 'toolu_1', name: 'audit_log', input: { order: 4411 } },
    ],
    id: 'msg_01',
  },
  {
    role: 'tool_result',
    toolCallId: 'toolu_1',
    toolName: 'audit_log',
    content: [text('Two refunds, one second apart.')],
    isError: false,
  },
  {
    role: 'native',
    provider: 'openai',
    api: 'openai-responses',
    content: [{ type: 'compaction', id: 'cmp_1' }],
  },
  { role: 'custom', tag: 'note', data: { by: 'the engine' } },
];

describe('messageSchema', () => {
  it('takes a message of every role, and gives it back as it was', () => {
    for (const message of MESSAGES) {
      expect(messageSchema.parse(message), message.role).toEqual(message);
    }
  });

  it('survives JSON', () => {
    for (const message of MESSAGES) {
      expect(messageSchema.parse(JSON.parse(JSON.stringify(message))), message.role).toEqual(
        message,
      );
    }
  });

  it('refuses a role there is none of, and a message without what its role has', () => {
    expect(messageSchema.safeParse({ role: 'developer', content: [] }).success).toBe(false);
    expect(messageSchema.safeParse({ role: 'assistant', content: [] }).success).toBe(false);
    expect(messageSchema.safeParse({ role: 'tool_result', content: [] }).success).toBe(false);
  });

  it('keeps an answer of a provider this package has never heard of', () => {
    const answer = {
      role: 'assistant',
      provider: 'some-new-provider',
      api: 'its-own',
      model: 'm-1',
      content: [{ any: ['thing'] }],
    };
    expect(messageSchema.parse(answer)).toEqual(answer);
  });
});

describe('contentPartSchema', () => {
  it("takes text, an image and a file, from a URL, as base64 or by the provider's file ID", () => {
    for (const part of [
      text('hello'),
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'file', source: { type: 'file_id', id: 'file_1' }, filename: 'report.pdf' },
      { type: 'text', text: 'cached', providerOptions: { cache_control: { type: 'ephemeral' } } },
    ]) {
      expect(contentPartSchema.parse(part), JSON.stringify(part)).toEqual(part);
    }
  });

  it('refuses a part of no known type, and an image from nowhere', () => {
    expect(contentPartSchema.safeParse({ type: 'audio', data: '' }).success).toBe(false);
    expect(contentPartSchema.safeParse({ type: 'image' }).success).toBe(false);
    expect(
      contentPartSchema.safeParse({ type: 'image', source: { type: 'url', url: 'not a url' } })
        .success,
    ).toBe(false);
  });
});

describe('toolDefinitionSchema', () => {
  it('takes a function tool and a custom tool', () => {
    const lookup = {
      type: 'function',
      name: 'lookup_order',
      description: 'Finds an order.',
      parameters: { type: 'object' },
    };
    const patch = {
      type: 'custom',
      name: 'apply_patch',
      description: 'Applies a patch.',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
    };
    expect(toolDefinitionSchema.parse(lookup)).toEqual(lookup);
    expect(toolDefinitionSchema.parse(patch)).toEqual(patch);
  });
});

describe('usageSchema', () => {
  it('takes counts that are known, and leaves out those that are not', () => {
    const usage = {
      input: 1200,
      output: 80,
      cacheRead: 0,
      cost: { source: 'estimated', total: 0.0042 },
    };
    expect(usageSchema.parse(usage)).toEqual(usage);
    expect(usageSchema.parse({})).toEqual({});
  });

  it('refuses a count that is not a whole number, 0 or more', () => {
    expect(usageSchema.safeParse({ input: -1 }).success).toBe(false);
    expect(usageSchema.safeParse({ output: 1.5 }).success).toBe(false);
  });
});
