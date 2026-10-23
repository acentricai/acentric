// Abort in every phase: stop what runs, keep partial output, give every
// tool call a result, clear the queues.

import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/index.js';
import { call, entries, failure, keyOf, reply, start, text } from './helpers.js';

describe('abort', () => {
  it('does nothing while idle', () => {
    const sim = start();
    const delivery = sim.input('abort', {});
    expect(delivery.rejected).toBeNull();
    expect(delivery.appended).toEqual([]);
  });

  it('aborts the model call and keeps its partial reply', () => {
    const sim = start();
    sim.input('prompt', { text: 'write an essay' });
    sim.input('follow_up', { text: 'and another' });
    const key = keyOf(sim, 'llm');

    const delivery = sim.input('abort', {});
    expect(delivery.aborted).toEqual([key]);
    expect(sim.snapshot.followUps).toEqual([]);
    expect(sim.input('prompt', { text: 'new' }).rejected).not.toBeNull();

    sim.ok(key, reply([text('Rome was founded')], 'aborted'));
    expect(sim.snapshot.phase).toEqual({ kind: 'idle' });
    expect(entries(sim, 'assistant')[0]?.body).toMatchObject({ stopReason: 'aborted' });
  });

  it('does not run the tool calls of a reply that finished as the abort arrived', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    const key = keyOf(sim, 'llm');
    sim.input('abort', {});
    sim.ok(key, reply([call('c1', 'bash', { command: 'rm -rf build' })]));

    expect(sim.effectsOf('bash')).toEqual([]);
    expect(entries(sim, 'tool_result')[0]?.body).toMatchObject({ toolCallId: 'c1', isError: true });
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('aborts running tools, keeps what they return, and answers waiting ones at once', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    const edit = { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] };
    sim.ok(
      keyOf(sim, 'llm'),
      reply([
        call('c1', 'bash', { command: 'make' }),
        call('c2', 'edit', edit),
        call('c3', 'edit', edit),
      ]),
    );
    expect(sim.running).toHaveLength(2);

    const delivery = sim.input('abort', {});
    expect(delivery.aborted).toHaveLength(2);
    sim.ok(keyOf(sim, 'bash'), {
      content: [text('compiling...\n\nCommand aborted')],
      isError: true,
    });
    sim.fail(keyOf(sim, 'edit'), 'aborted');

    expect(sim.snapshot.phase.kind).toBe('idle');
    const results = entries(sim, 'tool_result').map((entry) => entry.body);
    expect(results).toHaveLength(3);
    // Every call has its result, so the conversation stays valid.
    const context = buildContext(sim.log, null);
    expect(context.filter((message) => message.role === 'toolResult')).toHaveLength(3);
  });

  it('drops the retry timer', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.ok(keyOf(sim, 'llm'), failure('503 overloaded'));
    expect(sim.effectsOf('@timer')).toHaveLength(1);
    const delivery = sim.input('abort', {});
    expect(delivery.cancelled).toHaveLength(1);
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('turns compact during a run into an abort followed by a compaction', () => {
    const sim = start({ compaction: { keepRecentTokens: 1 } });
    sim.input('prompt', { text: 'first' });
    sim.ok(keyOf(sim, 'llm'), reply([text('one')]));
    sim.input('prompt', { text: 'second' });
    const key = keyOf(sim, 'llm');

    sim.input('compact', { instructions: 'keep it short' });
    sim.ok(key, reply([text('par')], 'aborted'));
    expect(sim.snapshot.phase).toMatchObject({
      kind: 'compacting',
      reason: 'manual',
      instructions: 'keep it short',
    });
    expect(sim.effectsOf('summarize')).toHaveLength(1);

    // While compacting, a second compact is rejected.
    expect(sim.input('compact', {}).rejected).toBe('already compacting');
  });
});
