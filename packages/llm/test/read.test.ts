import { describe, expect, it } from 'vitest';

import {
  outputText,
  pendingToolCalls,
  reasoningSummary,
  refusals,
  requestMessages,
  toolCalls,
  toolResult,
} from '../src/index.js';
import type { Message } from '../src/index.js';
import { anthropic, fireworks, openai } from './fixtures.js';

describe('the Responses format', () => {
  it('reads the answer, leaving out commentary unless asked', () => {
    expect(outputText(openai)).toBe('It is fixed.');
    expect(outputText(openai, { phase: 'all' })).toBe('Looking now.\n\nIt is fixed.');
    expect(outputText(fireworks)).toBe('Done.');
  });

  it('reads refusals and reasoning summaries', () => {
    expect(refusals(openai)).toEqual(['I will not delete the tests.']);
    expect(reasoningSummary(openai)).toEqual(['Reading the file first.']);
    expect(reasoningSummary(fireworks)).toEqual([]);
  });

  it('reads every call the caller answers, with what its result must repeat', () => {
    const calls = toolCalls(openai);
    expect(calls.map((call) => [call.toolCallId, call.toolType, call.toolName])).toEqual([
      ['call_read', 'function', 'read'],
      ['call_patch', 'custom', 'patch'],
      ['call_shell', 'native', 'shell'],
      ['apr_1', 'native', 'merge'],
    ]);
    expect(calls[0]).toMatchObject({
      arguments: '{"path":"a.ts"}',
      namespace: 'files',
      resultOptions: { caller: { type: 'program', caller_id: 'prog_1' }, namespace: 'files' },
      itemType: 'function_call',
    });
    expect(calls[1]).toMatchObject({ input: '*** Begin' });
    expect(calls[3]).toMatchObject({ namespace: 'github', itemType: 'mcp_approval_request' });
    expect(calls[2]).not.toHaveProperty('arguments');
  });

  it('leaves out of the pending calls one answered in the same output', () => {
    expect(pendingToolCalls(openai).map((call) => call.toolCallId)).toEqual([
      'call_read',
      'call_patch',
      'apr_1',
    ]);
  });
});

describe('the Anthropic format', () => {
  it('joins text split around citations, and has no refusals in content', () => {
    expect(outputText(anthropic)).toBe('The answer is 42');
    expect(refusals(anthropic)).toEqual([]);
  });

  it('reads thinking that has text', () => {
    expect(reasoningSummary(anthropic)).toEqual(['Check the docs.']);
  });

  it("reads calls to the caller's tools, not server tools, and all are pending", () => {
    const calls = toolCalls(anthropic);
    expect(calls).toEqual(pendingToolCalls(anthropic));
    expect(calls.map((call) => [call.toolCallId, call.arguments])).toEqual([
      ['toolu_1', '{"path":"a.ts"}'],
      ['toolu_2', '{}'],
    ]);
    expect(calls[1]?.resultOptions).toEqual({ toolset_name: 'computer' });
  });
});

describe('toolResult', () => {
  it('answers a call with what the provider requires on its result', () => {
    const [read] = toolCalls(openai);
    if (read === undefined) throw new Error('no call');
    expect(toolResult(read, 'export {}')).toEqual({
      role: 'tool_result',
      toolCallId: 'call_read',
      toolName: 'read',
      toolType: 'function',
      content: [{ type: 'text', text: 'export {}' }],
      providerOptions: { caller: { type: 'program', caller_id: 'prog_1' }, namespace: 'files' },
    });
    const [, screenshot] = toolCalls(anthropic);
    if (screenshot === undefined) throw new Error('no call');
    expect(toolResult(screenshot, 'no display', { isError: true })).toMatchObject({
      isError: true,
      providerOptions: { toolset_name: 'computer' },
    });
  });

  it('refuses a provider-defined call, which a native message answers', () => {
    const shell = toolCalls(openai).find((call) => call.toolType === 'native');
    if (shell === undefined) throw new Error('no call');
    expect(() => toolResult(shell, 'ok')).toThrow(/answer it with a native message/);
  });
});

describe('requestMessages', () => {
  it("leaves out the application's own messages", () => {
    const messages: Message<'openai'>[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'custom', tag: 'ui', data: { collapsed: true } },
      openai,
      {
        role: 'native',
        provider: 'openai',
        api: 'openai-responses',
        content: [{ type: 'compaction_trigger' }],
      },
    ];
    expect(requestMessages(messages).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'native',
    ]);
  });
});
