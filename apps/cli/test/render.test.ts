import { describe, expect, it } from 'vitest';

import type { ConversationEntry, Message } from '@acentric/protocol';

import { entryLines, table, turnText } from '../src/render.ts';

const entry = (seq: number, message: Message, more: Partial<ConversationEntry> = {}) =>
  entryLines({ seq, message, createdAt: 1_795_305_600_000, ...more });

describe('a conversation, as it is printed', () => {
  it('has a line for what a person said, with what is no text said by what it is', () => {
    expect(
      entry(1, { role: 'user', content: [{ type: 'text', text: 'Why two refunds?' }] }),
    ).toEqual(['#1 user: Why two refunds?']);
    const digest = 'ab'.repeat(32);
    expect(
      entry(2, {
        role: 'user',
        content: [
          { type: 'text', text: 'Look.' },
          { type: 'image', source: { type: 'blob', digest, mediaType: 'image/png', size: 180 } },
          {
            type: 'file',
            filename: 'contract.pdf',
            source: { type: 'url', url: 'https://example.com/c.pdf' },
          },
        ],
      }),
    ).toEqual([
      `#2 user: Look. [image: image/png, 180 bytes, blob ${digest}] [file contract.pdf: https://example.com/c.pdf]`,
    ]);
  });

  it('reads a model’s answer for its text and the tools it calls, whichever provider wrote it', () => {
    const answer = (content: Message & { role: 'assistant' }) => content;
    // As Anthropic writes one.
    expect(
      entry(
        3,
        answer({
          role: 'assistant',
          provider: 'anthropic',
          api: 'anthropic-messages',
          model: 'claude-haiku-5-5',
          content: [
            { type: 'thinking', thinking: 'Two refunds…', signature: 'sig' },
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 't1', name: 'lookup', input: { id: 4411 } },
          ],
        }),
      ),
    ).toEqual(['#3 assistant: Let me look.', '#3 assistant: → lookup({"id":4411})']);
    // As OpenAI writes one.
    expect(
      entry(
        4,
        answer({
          role: 'assistant',
          provider: 'openai',
          api: 'openai-responses',
          model: 'gpt-6-luna',
          content: [
            { type: 'reasoning', id: 'r1', summary: [] },
            { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"id":4411}' },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'It was refunded twice.' }],
            },
          ],
        }),
      ),
    ).toEqual(['#4 assistant: → lookup({"id":4411})', '#4 assistant: It was refunded twice.']);
  });

  it('says why a model stopped when that was not by ending or calling a tool', () => {
    const message: Message = {
      role: 'assistant',
      provider: 'fake',
      api: 'fake',
      model: 'fake-1',
      content: [],
    };
    expect(entry(5, message, { completion: { stopReason: 'refusal' } })).toEqual([
      '#5 assistant: (stopped: refusal)',
    ]);
    expect(entry(6, message, { completion: { stopReason: 'stop' } })).toEqual(['#6 assistant:']);
  });

  it('has a tool’s result under the tool’s name, and says when it failed', () => {
    const result = (isError: boolean): Message => ({
      role: 'tool_result',
      toolCallId: 'c1',
      toolName: 'lookup',
      content: [{ type: 'text', text: 'There is no order 9.' }],
      isError,
    });
    expect(entry(7, result(false))).toEqual(['#7 lookup: There is no order 9.']);
    expect(entry(8, result(true))).toEqual(['#8 lookup failed: There is no order 9.']);
  });

  it('says how a turn ended, with why when there is a why', () => {
    expect(turnText({ end: 'ok', at: 1 })).toBe('ok');
    expect(turnText({ end: 'failed', at: 1, reason: 'The provider is overloaded' })).toBe(
      'failed: The provider is overloaded',
    );
  });
});

describe('a table', () => {
  it('has each column as wide as its widest cell, and no space after the last', () => {
    expect(
      table(
        ['NAME', 'PROVIDER', 'DEFAULT'],
        [
          ['main', 'anthropic', 'yes'],
          ['a-longer-name', 'openai', ''],
        ],
      ),
    ).toEqual([
      'NAME           PROVIDER   DEFAULT',
      'main           anthropic  yes',
      'a-longer-name  openai',
    ]);
  });
});
