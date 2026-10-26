import { describe, expect, it } from 'vitest';

import { convert, toolCalls, toolResult } from '../src/index.js';
import type {
  AssistantMessage,
  ConversionChange,
  Message,
  ToolResultMessage,
} from '../src/index.js';
import { anthropic, openai } from './fixtures.js';

const user: Message = { role: 'user', content: [{ type: 'text', text: 'Fix it.' }] };

function results(message: AssistantMessage): ToolResultMessage[] {
  return toolCalls(message)
    .filter((call) => call.toolType !== 'native')
    .map((call) => toolResult(call, 'done'));
}

function what(changes: readonly ConversionChange[]): string[] {
  return changes.map((change) => `${change.action} ${change.what}: ${change.detail}`);
}

describe('convert', () => {
  it('keeps a conversation already for the target as it is', () => {
    const history: Message[] = [user, openai, ...results(openai)];
    const { messages, changes } = convert(history, { provider: 'openai', model: 'gpt-6.1-sol' });
    expect(messages[1]).toBe(openai);
    expect(messages).toEqual(history);
    expect(changes).toEqual([]);
  });

  it('drops reasoning bound to another model of the same provider, and keeps the rest', () => {
    const { messages, changes } = convert([openai], { provider: 'openai', model: 'gpt-6-luna' });
    const [converted] = messages;
    expect(converted).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', id: 'resp_1' });
    if (converted?.role !== 'assistant') throw new Error('not an assistant message');
    const types = converted.content.map((item) => item.type);
    expect(types).not.toContain('reasoning');
    expect(types).toContain('shell_call');
    expect(what(changes)).toEqual(['dropped reasoning: bound to its model']);
  });

  it('moves to another provider of the format, without what it cannot take', () => {
    const history: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Look.',
            providerOptions: { cache_control: { type: 'ephemeral' } },
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://x/a.png' },
            providerOptions: { detail: 'high' },
          },
          { type: 'image', source: { type: 'file_id', id: 'file_1' } },
          { type: 'file', source: { type: 'url', url: 'https://x/a.pdf' } },
        ],
      },
      openai,
      ...results(openai),
      {
        role: 'native',
        provider: 'openai',
        api: 'openai-responses',
        content: [{ type: 'compaction_trigger' }],
      },
      { role: 'custom', tag: 'ui', data: null },
    ];
    const { messages, changes } = convert(
      history,
      { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' },
      { reasoning: 'text' },
    );

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'custom',
    ]);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look.' },
        {
          type: 'image',
          source: { type: 'url', url: 'https://x/a.png' },
          providerOptions: { detail: 'high' },
        },
      ],
    });
    const converted = messages[1];
    if (converted?.role !== 'assistant') throw new Error('not an assistant message');
    expect(converted).toMatchObject({ provider: 'fireworks', api: 'openai-responses' });
    expect(converted).not.toHaveProperty('id');
    expect(converted.content).toEqual([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Reading the file first.' }] },
      {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Looking now.', annotations: [] }],
      },
      expect.objectContaining({ type: 'message', phase: 'final_answer' }),
      { type: 'function_call', call_id: 'call_read', name: 'read', arguments: '{"path":"a.ts"}' },
    ]);
    // The read call's result keeps no OpenAI-only fields.
    expect(messages[2]).toMatchObject({ toolCallId: 'call_read' });
    expect(messages[2]).not.toHaveProperty('providerOptions');
    expect(what(changes)).toEqual([
      'dropped part_option: cache_control',
      'dropped part: image by file ID: fireworks takes none',
      'dropped part: file part: fireworks takes no files',
      'rewritten reasoning: as a plain reasoning item',
      'dropped tool_call: custom tool patch',
      'dropped provider_item: shell_call',
      'dropped provider_item: shell_call_output',
      'dropped provider_item: mcp_approval_request',
      'dropped provider_item: tool_search_call',
      'dropped part_option: caller',
      'dropped part_option: namespace',
      'dropped tool_result: answers dropped call call_patch',
      'dropped message: openai native items',
    ]);
  });

  it('writes a Responses conversation as Anthropic blocks', () => {
    const reply: AssistantMessage<'openai'> = {
      role: 'assistant',
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-6.1-sol',
      content: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'See the docs.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x',
                  title: 'x',
                  start_index: 0,
                  end_index: 3,
                },
              ],
            },
            { type: 'refusal', refusal: 'Not that file.' },
          ],
        },
        {
          type: 'function_call',
          call_id: 'functions.read:0',
          name: 'read',
          arguments: '{"path":"a"}',
        },
        { type: 'function_call', call_id: 'call_2', name: 'list', arguments: '[1]' },
      ],
    };
    const { messages, changes } = convert([user, reply, ...results(reply)], {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    const converted = messages[1];
    if (converted?.role !== 'assistant') throw new Error('not an assistant message');
    const id = converted.content.find((block) => block.type === 'tool_use')?.['id'];
    expect(id).toMatch(/^functions_read_0_[a-z0-9]+$/);
    expect(converted.content).toEqual([
      { type: 'text', text: 'See the docs.' },
      { type: 'text', text: 'Not that file.' },
      { type: 'tool_use', id, name: 'read', input: { path: 'a' } },
      { type: 'tool_use', id: 'call_2', name: 'list', input: { arguments: '[1]' } },
    ]);
    // The result follows its call's new ID.
    expect(messages[2]).toMatchObject({ toolCallId: id });
    expect(what(changes)).toEqual([
      'dropped citations: 1 annotations',
      'rewritten refusal: as assistant text',
      `rewritten tool_call_id: functions.read:0 → ${String(id)}`,
      'rewritten tool_arguments: not a JSON object: wrapped as { arguments }',
    ]);
  });

  it('writes an Anthropic conversation in the Responses format', () => {
    const { messages, changes } = convert([anthropic], {
      provider: 'openai',
      model: 'gpt-6.1-sol',
    });
    const [converted] = messages;
    if (converted?.role !== 'assistant') throw new Error('not an assistant message');
    expect(converted.content).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'The answer is ', annotations: [] },
          { type: 'output_text', text: '42', annotations: [] },
        ],
      },
      { type: 'function_call', call_id: 'toolu_1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call', call_id: 'toolu_2', name: 'screenshot', arguments: '{}' },
    ]);
    // Reading the message reports citations; writing it reports the rest.
    expect(what(changes)).toEqual([
      'dropped citations: 1 citations',
      'dropped reasoning: bound to its model',
      'dropped reasoning: no readable text',
      'dropped reasoning: no readable text',
      'dropped provider_item: server_tool_use',
      'dropped provider_item: web_search_tool_result',
    ]);
  });

  it("keeps thinking as text when asked, and Anthropic's own blocks for another of its models", () => {
    const { messages } = convert(
      [anthropic],
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { reasoning: 'text' },
    );
    const [converted] = messages;
    if (converted?.role !== 'assistant') throw new Error('not an assistant message');
    expect(converted.content.map((block) => block.type)).toEqual([
      'text',
      'server_tool_use',
      'web_search_tool_result',
      'text',
      'text',
      'tool_use',
      'tool_use',
    ]);
    expect(converted.content[0]).toEqual({ type: 'text', text: 'Check the docs.' });
  });

  it('drops a message left empty, saying so', () => {
    const { messages, changes } = convert(
      [{ role: 'user', content: [{ type: 'file', source: { type: 'file_id', id: 'f' } }] }],
      { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p3' },
    );
    expect(messages).toEqual([]);
    expect(changes.at(-1)).toEqual({
      index: 0,
      action: 'dropped',
      what: 'message',
      detail: 'user message left empty',
    });
  });
});
