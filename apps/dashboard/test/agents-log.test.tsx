// The conversation as the actor page draws it: each turn a band, ended where the model answered
// with no tool call, and each compaction a rule after the message it reached. Then a notice
// with an image, and an answer in which the provider's own web search ran.

import type { Compaction } from '@acentric/protocol';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bandEnding,
  buildLog,
  describe as describeRow,
  type Band,
  type Message,
  type Rule,
} from '../src/agents/log/model.ts';
import { media, messageText, readResponse } from '../src/agents/log/read.ts';
import type { Standing } from '../src/agents/log/stream.ts';
import { MessageView } from '../src/agents/log/view.tsx';
import conversation from './fixtures/conversation.json' with { type: 'json' };

afterEach(cleanup);

const messages = conversation as unknown as Message[];
const idle: Standing = { status: 'idle', lastTurn: { end: 'ok', at: 1 }, pendingInputs: 0 };
const bands = (items: ReturnType<typeof buildLog>) =>
  items.filter((item): item is Band => item.type === 'band');
const at = <T,>(items: readonly T[], index: number): T => {
  const item = items.at(index);
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
};

describe('the log', () => {
  it('makes a band of each turn, from the first message after an answer to the next answer', () => {
    const items = bands(buildLog(messages, [], idle));
    expect(items.map((band) => [band.turn, band.first, band.last, band.status])).toEqual([
      [1, 1, 2, 'ended'],
      [2, 3, 6, 'ended'],
      [3, 7, 10, 'ended'],
    ]);
    expect(at(items, 1).calls).toBe(2);
    expect(at(items, 1).tokensIn).toBe(200);
    expect(at(items, 1).tokensOut).toBe(40);
  });

  it('says in its rows who sent what, what the model did and how each call went', () => {
    const all = bands(buildLog(messages, [], idle));
    const second = at(all, 1);
    expect(second.rows.map((row) => [row.seq, row.kind, row.summary, row.tone])).toEqual([
      [3, '← message', 'where is my order A-1042?', 'plain'],
      [4, 'model', '→ lookup_order', 'plain'],
      [5, '✓ lookup_order', 'A-1042', 'plain'],
      [6, 'model', 'The order has 10 lines. Anything else?', 'plain'],
    ]);
    expect(at(second.rows, 0).measure).toBe('m2');
    expect(at(at(all, 2).rows, 2)).toMatchObject({ kind: '✕ fail', tone: 'failed' });
  });

  it('gives each message one row, in order, however often and in whatever order it was read', () => {
    const shuffled = [...messages].toReversed().concat(messages.slice(0, 4));
    expect(buildLog(shuffled, [], idle)).toEqual(buildLog(messages, [], idle));
  });

  it('shows the turn going on as running, with the calls it waits on', () => {
    const partway = messages.slice(0, 4);
    const working: Standing = {
      status: 'working',
      lastTurn: { end: 'ok', at: 1 },
      pendingInputs: 0,
    };
    const last = at(bands(buildLog(partway, [], working)), -1);
    expect(last.status).toBe('running');
    expect(last.endedAt).toBeNull();
    expect(last.rows.at(-1)).toMatchObject({
      kind: '… lookup_order',
      measure: 'awaiting result',
      seq: null,
    });
    expect(bandEnding(last)).toBe('running');
  });

  it('says how the last turn ended when it did not end on an answer', () => {
    const partway = messages.slice(0, 5);
    const failed: Standing = {
      status: 'idle',
      lastTurn: { end: 'failed', reason: 'model_error', at: 1 },
      pendingInputs: 0,
    };
    const last = at(bands(buildLog(partway, [], failed)), -1);
    expect([last.status, bandEnding(last)]).toEqual(['failed', 'failed · model_error']);
    const interrupted: Standing = {
      status: 'idle',
      lastTurn: { end: 'interrupted', at: 1 },
      pendingInputs: 0,
    };
    expect(at(bands(buildLog(messages.slice(0, 4), [], interrupted)), -1).status).toBe(
      'interrupted',
    );
    // Earlier turns ended on an answer: how the last one went is not theirs.
    expect(at(bands(buildLog(partway, [], failed)), 0).status).toBe('ended');
  });

  it('draws a compaction as a rule after the message it reached', () => {
    const compaction: Compaction = {
      kind: 'older',
      atSeq: 6,
      keepFromSeq: 3,
      tokensBefore: 120_000,
      reason: 'threshold',
      createdAt: 5,
    };
    const items = buildLog(messages, [compaction], idle);
    expect(
      items.map((item) => (item.type === 'band' ? `turn ${String(item.turn)}` : 'rule')),
    ).toEqual(['turn 1', 'turn 2', 'rule', 'turn 3']);
    const rule = items[2] as Rule;
    expect(rule.row.rule).toBe(true);
    expect(rule.row.summary).toBe('compacted · older · 120k tokens · it grew past its size');
  });

  it('has nothing to draw before any message', () => {
    expect(buildLog([], [], undefined)).toEqual([]);
  });

  it('names a change of reasoning level, and shows other items of a provider by its name', () => {
    const native = (seq: number, content: unknown[]): Message =>
      ({
        seq,
        createdAt: 1,
        message: { role: 'native', provider: 'openai', api: 'openai-responses', content },
      }) as unknown as Message;
    const change = describeRow(
      native(1, [{ type: 'configuration_update', reasoning: { effort: 'high' } }]),
      new Map(),
    );
    expect([change.kind, change.summary, change.tone]).toEqual(['reasoning', 'now high', 'muted']);
    const other = describeRow(native(2, [{ type: 'compaction_trigger' }]), new Map());
    expect([other.kind, other.summary]).toEqual(['provider', 'openai']);
    // Anthropic's: a system message that says nothing and sets the effort.
    const anthropic = {
      seq: 3,
      createdAt: 1,
      message: {
        role: 'system',
        content: [],
        providerOptions: { output_config: { effort: 'xhigh' } },
      },
    } as unknown as Message;
    const row = describeRow(anthropic, new Map());
    expect([row.kind, row.summary]).toEqual(['reasoning', 'now xhigh']);
  });

  it('shows what a refused turn was sent and did, muted and marked as left out', () => {
    const said = {
      seq: 1,
      createdAt: 1,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      leftOut: true,
    } as unknown as Message;
    const row = describeRow(said, new Map());
    expect([row.tone, row.tags]).toEqual(['muted', ['left out']]);
    const kept = { ...said };
    delete kept.leftOut;
    expect(describeRow(kept, new Map()).tags).toEqual([]);
  });

  it('marks a task’s notice whose ending went wrong where the model was not told, such as a schedule handler', () => {
    const notice = (problem?: string): Message =>
      ({
        seq: 1,
        createdAt: 1,
        message: {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '<task id="t1" kind="schedule" status="done" ran="2s">\nCheck.\n</task>',
            },
          ],
          metadata: {
            notice: {
              task: 't1',
              kind: 'schedule',
              status: 'done',
              ...(problem === undefined ? {} : { problem }),
            },
          },
        },
      }) as unknown as Message;
    const failed = describeRow(notice('The schedule handler failed: no clock'), new Map());
    expect([failed.kind, failed.tone, failed.tags]).toEqual([
      'task',
      'failed',
      ['The schedule handler failed: no clock'],
    ]);
    const fine = describeRow(notice(), new Map());
    expect([fine.tone, fine.tags]).toEqual(['muted', []]);
  });

  it('names a message an input became by the input’s type', () => {
    const fromParent = {
      seq: 1,
      createdAt: 1,
      message: { role: 'user', content: [{ type: 'text', text: 'Count the bolts.' }] },
      input: { id: 'inp_1', type: 'message' },
    } as unknown as Message;
    expect(describeRow(fromParent, new Map()).kind).toBe('← message');
  });
});

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const notice = {
  seq: 4,
  createdAt: 1,
  message: {
    role: 'system',
    content: [
      { type: 'text', text: '<task id="s1" kind="code" status="done" ran="3s">\nlook\n' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXEL } },
      { type: 'text', text: '\nshown\n</task>' },
    ],
    metadata: { notice: { task: 's1', kind: 'code', status: 'done' } },
  },
} as unknown as Message;

describe('a notice with an image', () => {
  it('is a row of its text, and counts its image', () => {
    const row = describeRow(notice, new Map());
    expect([row.kind, row.summary, row.tone]).toEqual([
      'task',
      '<task id="s1" kind="code" status="done" ran="3s">',
      'muted',
    ]);
    expect(messageText(notice.message)).toBe(
      '<task id="s1" kind="code" status="done" ran="3s">\nlook\n\n\nshown\n</task>',
    );
    expect(media(notice.message)).toEqual({ images: 1, files: 0 });
  });

  it('shows the image between its texts', () => {
    const { container } = render(<MessageView message={notice.message} actor="act_1" />);
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
    // In order: the text before it, the image, the text after it.
    const html = container.innerHTML;
    expect(html.indexOf('look')).toBeGreaterThan(-1);
    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('look'));
    expect(html.indexOf('shown')).toBeGreaterThan(html.indexOf('<img'));
  });

  it('shows an image the server keeps from the actor’s blobs, and not one that may carry script', () => {
    const digest = 'a'.repeat(64);
    const kept = (mediaType: string) =>
      ({
        role: 'user',
        content: [{ type: 'image', source: { type: 'blob', digest, mediaType, size: 10 } }],
      }) as unknown as Message['message'];
    const { container } = render(<MessageView message={kept('image/png')} actor="act_9" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `/v1/actors/act_9/blobs/${digest}`,
    );
    cleanup();
    const svg = render(<MessageView message={kept('image/svg+xml')} actor="act_9" />);
    expect(svg.container.querySelector('img')).toBeNull();
    expect(svg.container.textContent).toContain('image');
  });
});

const answer = (provider: string, content: object[]): Message =>
  ({
    seq: 2,
    createdAt: 1,
    message: {
      role: 'assistant',
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      model: 'm',
      content,
    },
  }) as unknown as Message;

describe('an answer that searched the web', () => {
  it('names the search in its row, on Anthropic and on OpenAI', () => {
    const anthropic = answer('anthropic', [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'node release' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'text', text: 'Node 26.' },
    ]);
    expect(describeRow(anthropic, new Map()).summary).toBe('Node 26. → web search');
    expect(readResponse(anthropic.message as never).searches).toEqual(['node release']);

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
    expect(describeRow(openai, new Map()).summary).toBe('Node 26. → web search, web search');
    expect(readResponse(openai.message as never).searches).toEqual([
      'node lts',
      'https://nodejs.org/',
    ]);
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
      ]).message as never,
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
      ]).message as never,
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
