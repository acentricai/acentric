// The basic run: prompt, model call, tool calls, model call again, idle.

import { describe, expect, it } from 'vitest';

import { buildContext, init } from '../src/index.js';
import { CWD, call, config, entries, keyOf, reply, start, text, toolOk } from './helpers.js';

/** Arguments for an edit to `path`. */
const edit = (path: string) => ({ path, edits: [{ oldText: 'a', newText: 'b' }] });

describe('init', () => {
  it('resolves the defaults and records the starting model and thinking level', () => {
    const sim = start();
    expect(sim.snapshot.settings).toEqual({
      cwd: CWD,
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 },
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    });
    expect(sim.snapshot.thinkingLevel).toBe('medium');
    expect(sim.log.map((entry) => entry.kind)).toEqual(['model_change', 'thinking_change']);
    expect(sim.snapshot.phase).toEqual({ kind: 'idle' });
    expect(sim.running).toEqual([]);
  });

  it('rejects a model that is not in the catalog', () => {
    expect(init(config({ model: { provider: 'acme', id: 'nope' } }), 0)).toEqual({
      error: 'unknown model acme/nope',
    });
  });

  it('rejects a config of the wrong shape', () => {
    // @ts-expect-error a config that does not match PiConfig, as a caller might send
    expect(init({ ...config(), retry: { maxRetries: 'three' } }, 0)).toEqual({
      error: 'retry.maxRetries must be a number',
    });
  });
});

describe('a run', () => {
  it('calls the model with the conversation and goes idle when it stops without tools', () => {
    const sim = start();
    sim.input('prompt', { text: 'hi' });

    const [llm] = sim.effectsOf('llm');
    expect(llm?.args).toEqual({
      model: { provider: 'anthropic', id: 'claude-sonnet-5-5' },
      thinkingLevel: 'medium',
      cwd: CWD,
      compactionSeq: null,
      fromSeq: 1,
      toSeq: 4,
    });
    expect(entries(sim, 'user').map((entry) => entry.body)).toEqual([
      { content: [text('hi')], via: 'prompt' },
    ]);

    sim.ok(keyOf(sim, 'llm'), reply([text('hello')]));
    expect(sim.snapshot.phase).toEqual({ kind: 'idle' });
    expect(sim.running).toEqual([]);
    expect(entries(sim, 'assistant')).toHaveLength(1);
  });

  it('runs every tool call at once, then calls the model again with the results in call order', () => {
    const sim = start();
    sim.input('prompt', { text: 'look around' });
    sim.ok(
      keyOf(sim, 'llm'),
      reply([call('c1', 'read', { path: 'a.ts' }), call('c2', 'bash', { command: 'ls' })]),
    );

    const assistantSeq = entries(sim, 'assistant')[0]?.seq;
    expect(sim.running.map((request) => [request.kind, request.args])).toEqual([
      ['read', { seq: assistantSeq, toolCallId: 'c1', cwd: CWD }],
      ['bash', { seq: assistantSeq, toolCallId: 'c2', cwd: CWD }],
    ]);

    // bash finishes first.
    sim.ok(keyOf(sim, 'bash'), toolOk('a.ts'));
    expect(sim.effectsOf('llm')).toEqual([]);
    sim.ok(keyOf(sim, 'read'), toolOk('export {}'));

    const [next] = sim.effectsOf('llm');
    expect(next?.args.toSeq).toBe(sim.log.length + 1);

    const context = buildContext(sim.log, null);
    expect(context.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'toolResult',
    ]);
    expect(
      context
        .slice(2)
        .map((message) => (message.role === 'toolResult' ? message.toolCallId : null)),
    ).toEqual(['c1', 'c2']);
  });

  it('answers an unknown tool and invalid arguments at once, then calls the model again', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.ok(
      keyOf(sim, 'llm'),
      reply([call('c1', 'grep', { pattern: 'x' }), call('c2', 'read', {})]),
    );

    const results = entries(sim, 'tool_result').map((entry) => entry.body);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      toolCallId: 'c1',
      isError: true,
      content: [text('Tool grep not found')],
    });
    expect(results[1]).toMatchObject({ toolCallId: 'c2', isError: true });
    expect(JSON.stringify(results[1])).toContain('must have required properties path');
    expect(sim.effectsOf('llm')).toHaveLength(1);
  });

  it('fails every tool call when the reply hit the output limit', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.ok(keyOf(sim, 'llm'), reply([call('c1', 'write', { path: 'a', content: 'x' })], 'length'));

    expect(entries(sim, 'tool_result')[0]?.body).toMatchObject({ toolCallId: 'c1', isError: true });
    expect(sim.effectsOf('write')).toEqual([]);
    expect(sim.effectsOf('llm')).toHaveLength(1);
  });

  it('runs edits to one file one at a time, and edits to other files alongside', () => {
    const sim = start();
    sim.input('prompt', { text: 'edit' });
    sim.ok(
      keyOf(sim, 'llm'),
      reply([
        call('c1', 'edit', edit('src/x.ts')),
        call('c2', 'edit', edit('./src/x.ts')),
        call('c3', 'write', { path: 'src/y.ts', content: 'y' }),
      ]),
    );
    expect(sim.running.map((request) => request.args)).toEqual([
      expect.objectContaining({ toolCallId: 'c1' }),
      expect.objectContaining({ toolCallId: 'c3' }),
    ]);

    const [first] = sim.effectsOf('edit');
    const delivery = sim.ok(first?.key ?? '', toolOk('done'));
    expect(delivery.started.map((request) => request.args)).toEqual([
      expect.objectContaining({ toolCallId: 'c2' }),
    ]);
  });

  it('records a failed or interrupted tool as an error result', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.ok(
      keyOf(sim, 'llm'),
      reply([call('c1', 'bash', { command: 'make' }), call('c2', 'read', { path: 'a' })]),
    );
    sim.interrupt(keyOf(sim, 'bash'));
    sim.fail(keyOf(sim, 'read'), 'threw', { name: 'Error', message: 'ENOENT: no such file' });

    expect(entries(sim, 'tool_result').map((entry) => entry.body)).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        isError: true,
        content: [text('Interrupted: the tool call may or may not have run.')],
      }),
      expect.objectContaining({
        toolCallId: 'c2',
        isError: true,
        content: [text('ENOENT: no such file')],
      }),
    ]);
  });
});
