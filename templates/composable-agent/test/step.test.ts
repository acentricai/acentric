// The loop as STEP.md says it, driven through the simulator: the tests play
// the model, the tools, the timer and the summary by hand. The template
// has no tools of its own, so the tests give it some.

import { simulate } from '@acentric/testing';
import type { JsonObject } from '@acentric/types';
import { describe, expect, it, vi } from 'vitest';

import agent from '../src/agent.js';
import type { Config } from '../src/types/config.js';
import { call, llmError, reply, text } from './fixtures.js';

vi.mock('../src/tools/list.js', async () => ({
  TOOLS: (await import('./fixtures.js')).TEST_TOOLS,
}));

const SONNET = { provider: 'anthropic', id: 'claude-sonnet-5-5' };

function start(config: Config = {}) {
  return simulate(agent, config, { now: 1_000 });
}

type Sim = ReturnType<typeof start>;

const kinds = (sim: Sim) => sim.log.map((entry) => entry.kind);
const keys = (sim: Sim) => sim.running.map((request) => request.key);
const body = (sim: Sim, seq: number) => sim.log.find((entry) => entry.seq === seq)?.body;

/** A turn started with `hi`, with the model call llm:1 running. */
function talking(config: Config = {}): Sim {
  const sim = start(config);
  sim.input('message', { text: 'hi' });
  return sim;
}

function replyWithCalls(sim: Sim, key: string, calls: JsonObject[]) {
  return sim.ok(key, reply(calls, 'tool_use'));
}

describe('a turn', () => {
  it('starts with a message and calls the model', () => {
    const sim = talking();
    expect(kinds(sim)).toEqual(['notice', 'user']);
    expect(sim.running).toEqual([
      {
        key: 'llm:1',
        kind: 'llm',
        abort: false,
        args: {
          model: SONNET,
          thinking: 'medium',
          context: { summarySeq: null, fromSeq: 1, toSeq: 3 },
          prompt: {},
          tools: ['echo', 'edit', 'serial', 'note'],
        },
      },
    ]);
  });

  it('ends when the model replies without tool calls', () => {
    const sim = talking();
    sim.ok('llm:1', reply([text('hello')], 'stop', { totalInput: 100, output: 20 }));
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
    expect(sim.snapshot.turn).toBeNull();
    expect(sim.running).toEqual([]);
    expect(sim.snapshot.totals).toMatchObject({
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('calls the model again after pause_turn', () => {
    const sim = talking();
    sim.ok('llm:1', reply([text('working')], 'pause_turn'));
    expect(keys(sim)).toEqual(['llm:2']);
  });

  it('answers calls cut off by the length limit, and calls the model again', () => {
    const sim = talking();
    sim.ok('llm:1', reply([call('c1', 'echo', { text: 'x' })], 'length'));
    expect(body(sim, 4)).toMatchObject({ toolCallId: 'c1', isError: true });
    expect(keys(sim)).toEqual(['llm:2']);
  });

  it('stops a turn after the most model calls', () => {
    const sim = talking();
    for (let n = 1; n <= 50; n += 1) {
      replyWithCalls(sim, `llm:${n}`, [call(`c${n}`, 'note', { text: 'x' })]);
    }
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
    expect(sim.log.at(-1)).toMatchObject({
      kind: 'notice',
      body: { text: 'the turn was stopped after 50 model calls' },
    });
  });
});

describe('tools', () => {
  it('runs calls in parallel, pointing at the reply, and calls the model with their results', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('c1', 'echo', { text: 'a' }),
      call('c2', 'echo', { text: 'b' }),
    ]);
    expect(keys(sim)).toEqual(['tool:2', 'tool:3']);
    expect(sim.effect('tool:2')).toMatchObject({
      kind: 'tool:echo',
      args: { replySeq: 3, callId: 'c1', extra: {} },
    });

    sim.ok('tool:3', { content: 'B' });
    expect(body(sim, 4)).toMatchObject({
      toolCallId: 'c2',
      content: [{ type: 'text', text: 'B' }],
    });
    expect(keys(sim)).toEqual(['tool:2']);

    sim.ok('tool:2', { content: 'A' });
    expect(keys(sim)).toEqual(['llm:4']);
    expect(sim.effect('llm:4')).toMatchObject({ args: { context: { toSeq: 6 } } });
  });

  it('answers an unknown tool, bad arguments and a tool that answers itself at once', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('x1', 'nope', {}),
      call('x2', 'echo', { text: 5 }),
      call('x3', 'note', { text: 'remember' }),
    ]);
    expect(body(sim, 4)).toMatchObject({
      isError: true,
      content: [{ text: 'there is no tool named nope' }],
    });
    expect(body(sim, 5)).toMatchObject({
      isError: true,
      content: [{ text: 'invalid arguments to echo: arguments/text must be string' }],
    });
    expect(body(sim, 6)).toEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'noted: remember' }] }),
    );
    expect(body(sim, 6)).not.toHaveProperty('isError');
    expect(keys(sim)).toEqual(['llm:2']);
  });

  it('runs calls with the same resource key one at a time', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('e1', 'edit', { path: 'a.txt', text: '1' }),
      call('e2', 'edit', { path: 'a.txt', text: '2' }),
      call('e3', 'edit', { path: 'b.txt', text: '3' }),
    ]);
    expect(keys(sim)).toEqual(['tool:2', 'tool:4']);
    sim.ok('tool:2', { content: 'ok' });
    expect(keys(sim).toSorted()).toEqual(['tool:3', 'tool:4']);
  });

  it('runs a sequential call alone', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('s1', 'echo', { text: 'x' }),
      call('s2', 'serial', { text: 'y' }),
      call('s3', 'echo', { text: 'z' }),
    ]);
    expect(keys(sim)).toEqual(['tool:2']);
    sim.ok('tool:2', { content: 'x' });
    expect(keys(sim)).toEqual(['tool:3']);
    sim.ok('tool:3', { content: 'y' });
    expect(keys(sim)).toEqual(['tool:4']);
  });

  it('tells the model when a call failed or was cut off', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('f1', 'echo', { text: 'x' }),
      call('f2', 'edit', { path: 'a.txt', text: 'y' }),
    ]);
    sim.fail('tool:2', 'threw', { name: 'Error', message: 'boom' });
    expect(body(sim, 4)).toMatchObject({ isError: true, content: [{ text: 'echo failed: boom' }] });
    sim.interrupt('tool:3');
    expect(body(sim, 5)).toMatchObject({
      isError: true,
      content: [
        { text: 'edit was cut off and may or may not have finished; check before trying it again' },
      ],
    });
  });
});

describe('messages during a turn', () => {
  it('steers at the model’s next call, after the tool results', () => {
    const sim = talking();
    sim.input('message', { text: 'also this' });
    expect(sim.snapshot.steering).toEqual([3]);
    replyWithCalls(sim, 'llm:1', [call('c1', 'echo', { text: 'a' })]);
    sim.ok('tool:2', { content: 'A' });
    expect(kinds(sim)).toEqual(['notice', 'user', 'queued', 'assistant', 'tool_result', 'user']);
    expect(body(sim, 6)).toEqual(body(sim, 3));
    expect(sim.snapshot.steering).toEqual([]);
    expect(sim.effect('llm:3')).toMatchObject({ args: { context: { toSeq: 7 } } });
  });

  it('keeps a turn going when a steer arrives as it would end', () => {
    const sim = talking();
    sim.input('message', { text: 'one more thing' });
    sim.ok('llm:1', reply([text('done')]));
    expect(kinds(sim).at(-1)).toBe('user');
    expect(keys(sim)).toEqual(['llm:2']);
    expect(sim.snapshot.turn?.modelCalls).toBe(2);
  });

  it('queues for the next turn', () => {
    const sim = talking();
    sim.input('message', { text: 'next', delivery: 'queue' });
    expect(sim.snapshot.queued).toEqual([3]);
    sim.ok('llm:1', reply([text('done')]));
    expect(keys(sim)).toEqual(['llm:2']);
    expect(sim.snapshot.turn?.modelCalls).toBe(1);
    expect(body(sim, 5)).toEqual(body(sim, 3));
  });

  it('uses the configured delivery when a message names none', () => {
    const sim = talking({ inputs: { defaultDelivery: 'queue' } });
    sim.input('message', { text: 'next' });
    expect(sim.snapshot.queued).toEqual([3]);
    expect(sim.snapshot.steering).toEqual([]);
  });

  it('rejects a message that fails its schema, changing nothing', () => {
    const sim = talking();
    const delivery = sim.input('message', { text: '' });
    expect(delivery.rejected).toMatch(/^invalid message input/);
    expect(delivery.appended).toEqual([]);
  });
});

describe('interrupt', () => {
  it('aborts the model call, drops waiting messages, and goes idle when it reports', () => {
    const sim = talking();
    sim.input('message', { text: 'later', delivery: 'queue' });
    const delivery = sim.input('interrupt', {});
    expect(delivery.aborted).toEqual(['llm:1']);
    expect(sim.snapshot.queued).toEqual([]);
    expect(sim.log.at(-1)).toMatchObject({
      kind: 'notice',
      body: { text: 'the interrupt dropped 1 waiting message(s)' },
    });
    sim.fail('llm:1', 'aborted');
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
    expect(kinds(sim)).not.toContain('model_error');
  });

  it('keeps a reply that arrives anyway, without running its calls', () => {
    const sim = talking();
    sim.input('interrupt', {});
    replyWithCalls(sim, 'llm:1', [call('c1', 'echo', { text: 'a' })]);
    expect(body(sim, 4)).toMatchObject({
      isError: true,
      content: [{ text: 'echo was not run: the turn was interrupted' }],
    });
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });

  it('aborts running tool calls and never starts waiting ones', () => {
    const sim = talking();
    replyWithCalls(sim, 'llm:1', [
      call('e1', 'edit', { path: 'a.txt', text: '1' }),
      call('e2', 'edit', { path: 'a.txt', text: '2' }),
      call('c3', 'echo', { text: 'x' }),
    ]);
    expect(sim.input('interrupt', {}).aborted).toEqual(['tool:2', 'tool:4']);
    sim.fail('tool:2', 'aborted');
    expect(body(sim, 4)).toMatchObject({ content: [{ text: 'edit was stopped by an interrupt' }] });
    sim.ok('tool:4', { content: 'x' });
    expect(body(sim, 6)).toMatchObject({
      toolCallId: 'e2',
      content: [{ text: 'edit was not run: the turn was interrupted' }],
    });
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });

  it('starts a fresh turn with a message sent after it', () => {
    const sim = talking();
    sim.input('interrupt', {});
    sim.input('message', { text: 'do this instead' });
    sim.fail('llm:1', 'aborted');
    expect(keys(sim)).toEqual(['llm:2']);
    expect(sim.snapshot.turn).toMatchObject({ stopping: false, modelCalls: 1 });
    expect(sim.effect('llm:2')).toMatchObject({ abort: false });
  });

  it('ends the turn at once while waiting to retry', () => {
    const sim = talking();
    sim.fail('llm:1', 'threw', llmError('overloaded', true));
    expect(sim.input('interrupt', {}).cancelled).toEqual(['timer:2']);
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });

  it('does nothing while idle', () => {
    const sim = start();
    const delivery = sim.input('interrupt', {});
    expect(delivery.rejected).toBeNull();
    expect(delivery.appended).toEqual([]);
  });
});

describe('failed model calls', () => {
  it('retries a retryable failure after a backoff', () => {
    const sim = talking();
    sim.fail('llm:1', 'threw', llmError('overloaded', true));
    expect(sim.log.at(-1)).toMatchObject({ kind: 'model_error', body: { retrying: true } });
    expect(sim.running).toEqual([{ key: 'timer:2', kind: '@timer', args: { at: 3_000 } }]);
    sim.ok('timer:2', null);
    expect(keys(sim)).toEqual(['llm:3']);
    sim.fail('llm:3', 'threw', llmError('overloaded', true));
    expect(sim.effect('timer:4')).toMatchObject({ args: { at: 5_000 } });
  });

  it('waits as long as the provider asks, up to the most', () => {
    const sim = talking();
    sim.fail('llm:1', 'threw', llmError('rate_limited', true, { retryAfterMs: 30_000 }));
    expect(sim.effect('timer:2')).toMatchObject({ args: { at: 31_000 } });
  });

  it('retries a runner timeout', () => {
    const sim = talking();
    sim.fail('llm:1', 'timeout', { timeoutMs: 1 });
    expect(keys(sim)).toEqual(['timer:2']);
  });

  it('ends the turn on a failure it cannot retry', () => {
    const sim = talking();
    sim.fail('llm:1', 'threw', llmError('auth', false));
    expect(sim.log.at(-1)).toMatchObject({ kind: 'model_error', body: { retrying: false } });
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });

  it('gives up after the most retries', () => {
    const sim = talking({ retry: { maxRetries: 1 } });
    sim.fail('llm:1', 'threw', llmError('overloaded', true));
    sim.ok('timer:2', null);
    sim.fail('llm:3', 'threw', llmError('overloaded', true));
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });
});

describe('compaction', () => {
  it('compacts once after an overflow, and calls the model with the summary', () => {
    const sim = start({ compaction: { triggerTokens: 100_000, keepTokens: 50 } });
    sim.input('message', { text: 'a'.repeat(800) });
    sim.ok('llm:1', reply([text('b'.repeat(400))]));
    sim.input('message', { text: 'short' });
    sim.fail('llm:2', 'threw', llmError('context_overflow', false));
    expect(sim.running).toEqual([
      {
        key: 'summarize:3',
        kind: 'summarize',
        args: { model: SONNET, fromSeq: 1, toSeq: 3, previousSummarySeq: null },
      },
    ]);

    sim.ok('summarize:3', { summary: 'S', usage: null });
    expect(body(sim, 6)).toMatchObject({ summary: 'S', firstKeptSeq: 3 });
    expect(sim.snapshot.compaction).toEqual({ entrySeq: 6, firstKeptSeq: 3 });
    expect(sim.effect('llm:4')).toMatchObject({
      args: { context: { summarySeq: 6, fromSeq: 3, toSeq: 7 } },
    });
    expect(sim.state().log.start).toBe(3);

    sim.fail('llm:4', 'threw', llmError('context_overflow', false));
    expect(sim.log.at(-1)).toMatchObject({ kind: 'model_error', body: { retrying: false } });
    expect(sim.snapshot.phase).toEqual({ type: 'idle' });
  });

  it('compacts after a turn over the threshold, and a message then waits for the next turn', () => {
    const sim = start({ compaction: { triggerTokens: 50, keepTokens: 10 } });
    sim.input('message', { text: 'hi' });
    sim.ok('llm:1', reply([text('ok')], 'stop', { totalInput: 500, output: 10 }));
    expect(sim.snapshot.phase).toMatchObject({ type: 'compacting', thenContinue: false });
    expect(sim.snapshot.turn).toBeNull();

    sim.input('message', { text: 'more' });
    expect(sim.snapshot.queued).toEqual([4]);

    sim.ok('summarize:2', { summary: 'S', usage: { totalInput: 50, output: 5 } });
    expect(sim.snapshot.compaction).toEqual({ entrySeq: 5, firstKeptSeq: 2 });
    expect(sim.effect('llm:3')).toMatchObject({
      args: { context: { summarySeq: 5, fromSeq: 2, toSeq: 7 } },
    });
    expect(sim.snapshot.totals.modelCalls).toBe(2);
  });
});

describe('config', () => {
  it('rejects a config whose fields do not work together', () => {
    const sim = start();
    expect(sim.configure({ compaction: { triggerTokens: 10 } }).rejected).toBe(
      'invalid config: compaction.keepTokens (20000) must be below compaction.triggerTokens (10)',
    );
  });

  it('applies from the model’s next call', () => {
    const sim = talking();
    const gpt = { provider: 'openai', id: 'gpt-5.4-mini' } as const;
    expect(sim.configure({ model: gpt }).rejected).toBeNull();
    expect(sim.effect('llm:1')).toMatchObject({ args: { model: SONNET } });
    sim.ok('llm:1', reply([text('working')], 'pause_turn'));
    expect(sim.effect('llm:2')).toMatchObject({ args: { model: gpt } });
  });
});
