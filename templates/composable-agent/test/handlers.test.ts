// The model calls: what the model sees of the log, the request each call
// builds, and the llm and summarize handlers run on their own against a
// provider that answers from the test.

import { handlerContext } from '@acentric/testing';
import type { Json, JsonObject, LogEntry } from '@acentric/types';
import { describe, expect, it } from 'vitest';

import { summarizeHandler } from '../src/compaction/handler.js';
import { context, SUMMARY_INSTRUCTIONS } from '../src/compaction/index.js';
import { conversationMessages } from '../src/core/conversation.js';
import { readEntries } from '../src/core/read.js';
import { llmHandler } from '../src/loop/handler.js';
import type { LlmArgs } from '../src/loop/kinds.js';
import { buildRequest } from '../src/loop/request.js';
import { call, reply, text } from './fixtures.js';

const SONNET = { provider: 'anthropic', id: 'claude-sonnet-5-5' } as const;

function entry(seq: number, kind: string, body: Json): LogEntry {
  return { seq, at: 0, kind, body };
}

function user(seq: number, value: string): LogEntry {
  return entry(seq, 'user', { role: 'user', content: [text(value)] });
}

function result(seq: number, callId: string, value: string): LogEntry {
  return entry(seq, 'tool_result', {
    role: 'tool_result',
    toolCallId: callId,
    toolName: 'echo',
    toolType: 'function',
    content: [text(value)],
  });
}

function args(fields: Partial<LlmArgs> = {}): LlmArgs {
  return {
    model: SONNET,
    thinking: 'medium',
    context: { summarySeq: null, fromSeq: 1, toSeq: 2 },
    prompt: {},
    tools: [],
    ...fields,
  };
}

/** A provider that records what it is sent and answers like Anthropic, with `content`. */
function anthropic(content: JsonObject[]) {
  const sent: JsonObject[] = [];
  const fetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const body = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { fetch, sent };
}

const KEY = { ANTHROPIC_API_KEY: 'test-key' };

describe('what the model sees', () => {
  it('gives tool results back in the order of the reply’s calls, and nothing that is not conversation', () => {
    const messages = conversationMessages([
      user(2, 'go'),
      entry(3, 'assistant', reply([call('c1', 'echo', {}), call('c2', 'echo', {})], 'tool_use')),
      result(4, 'c2', 'second'),
      entry(5, 'notice', { level: 'info', text: 'for UIs' }),
      result(6, 'c1', 'first'),
      entry(7, 'queued', { role: 'user', content: [text('waiting')] }),
      user(8, 'steer'),
    ]);
    expect(messages.map((m) => ('toolCallId' in m ? m.toolCallId : m.role))).toEqual([
      'user',
      'assistant',
      'c1',
      'c2',
      'user',
    ]);
  });

  it('puts the latest summary before the kept entries', () => {
    const entries = [
      user(2, 'old'),
      user(3, 'kept'),
      entry(4, 'compaction', { summary: 'S', firstKeptSeq: 3, tokensBefore: 9, model: SONNET }),
      user(5, 'after'),
    ];
    const messages = context(entries, { summarySeq: 4, fromSeq: 3, toSeq: 6 });
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages[0])).toContain('<summary>\\nS\\n</summary>');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: [text('kept')] },
      { role: 'user', content: [text('after')] },
    ]);
  });
});

describe('the request', () => {
  it('asks Anthropic to think adaptively at the level, with the instructions and no empty tools', () => {
    const request = buildRequest(args({ thinking: 'high' }), [user(1, 'hi')]);
    expect(request).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      instructions: 'You are a helpful assistant.',
      options: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    });
    expect(request).not.toHaveProperty('tools');
  });

  it('turns thinking off, and gives OpenAI a reasoning effort', () => {
    expect(buildRequest(args({ thinking: 'off' }), [user(1, 'hi')]).options).toEqual({
      thinking: { type: 'disabled' },
    });
    const gpt = buildRequest(args({ model: { provider: 'openai', id: 'gpt-5.4-mini' } }), [
      user(1, 'hi'),
    ]);
    expect(gpt.options).toEqual({ reasoning: { effort: 'medium' } });
  });

  it('converts replies from another provider, after the model changed', () => {
    const entries = [user(1, 'hi'), entry(2, 'assistant', reply([text('hello')])), user(3, 'more')];
    const request = buildRequest(
      args({
        model: { provider: 'openai', id: 'gpt-5.4-mini' },
        context: { summarySeq: null, fromSeq: 1, toSeq: 4 },
      }),
      entries,
    );
    expect(request.messages[1]).toMatchObject({ role: 'assistant', provider: 'openai' });
  });
});

describe('reading the log', () => {
  it('reads every page of a range', async () => {
    const log = [user(1, 'a'), user(2, 'b'), user(3, 'c'), user(4, 'd')];
    const { ctx } = handlerContext({ args: {}, log, pageSize: 1 });
    expect((await readEntries(ctx.log, 2, 4)).map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('the llm handler', () => {
  it('reads the conversation from the log and calls the model', async () => {
    const provider = anthropic([text('hello')]);
    const { ctx } = handlerContext({ args: args(), log: [user(1, 'hi')], secrets: KEY });
    const response = await llmHandler({ fetch: provider.fetch }).run(ctx);
    expect(response.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(provider.sent[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user' }],
    });
    expect(JSON.stringify(provider.sent[0])).toContain('You are a helpful assistant.');
  });

  it('fails as an LlmError step can read, when no key is set', async () => {
    const { ctx } = handlerContext({ args: args(), log: [user(1, 'hi')] });
    await expect(llmHandler({ gateway: false }).run(ctx)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'auth',
    });
  });
});

describe('the summarize handler', () => {
  it('summarises the range, extending the previous summary', async () => {
    const provider = anthropic([text('NEW')]);
    const log = [
      user(2, 'first'),
      entry(3, 'assistant', reply([text('answer')])),
      entry(4, 'compaction', { summary: 'OLD', firstKeptSeq: 2, tokensBefore: 9, model: SONNET }),
      user(5, 'later'),
    ];
    const { ctx } = handlerContext({
      args: { model: SONNET, fromSeq: 2, toSeq: 5, previousSummarySeq: 4 },
      log,
      secrets: KEY,
    });
    const summary = await summarizeHandler({ fetch: provider.fetch }).run(ctx);
    expect(summary).toEqual({ summary: 'NEW', usage: expect.objectContaining({ output: 20 }) });
    const sent = JSON.stringify(provider.sent[0]);
    expect(sent).toContain(JSON.stringify(SUMMARY_INSTRUCTIONS).slice(1, 40));
    expect(sent).toContain('OLD');
    expect(sent).not.toContain('later');
  });
});
