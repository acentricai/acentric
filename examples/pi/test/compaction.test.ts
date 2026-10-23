// Compaction: manual, by threshold, and after a context overflow.

import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/index.js';
import { entries, failure, keyOf, reply, start, text, usage } from './helpers.js';

const summary = { summary: '## Goal\nTest compaction', usage: usage(500) };

describe('compaction', () => {
  it('says there is nothing to compact when everything fits in what is kept', () => {
    const sim = start();
    sim.input('compact', {});
    expect(entries(sim, 'notice')[0]?.body).toEqual({ level: 'info', text: 'Nothing to compact.' });
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('summarises older history and shows the model the summary, then what was kept', () => {
    const sim = start({ compaction: { keepRecentTokens: 1 } });
    sim.input('prompt', { text: 'first task' });
    sim.ok(keyOf(sim, 'llm'), reply([text('done first')]));
    sim.input('prompt', { text: 'second task' });
    sim.ok(keyOf(sim, 'llm'), reply([text('done second')]));

    sim.input('compact', {});
    const request = sim.effectsOf('summarize')[0];
    expect(request?.args).toMatchObject({
      fromSeq: 1,
      previousSummarySeq: null,
      instructions: null,
    });
    sim.ok(request?.key ?? '', summary);

    const compaction = entries(sim, 'compaction')[0];
    expect(compaction?.body).toMatchObject({ summary: summary.summary });
    expect(sim.snapshot.compaction?.seq).toBe(compaction?.seq);
    expect(sim.snapshot.phase.kind).toBe('idle');

    // The window now starts at the first kept entry.
    const window = sim.state().log;
    expect(window.start).toBe(sim.snapshot.compaction?.firstKeptSeq);
    const context = buildContext(window.entries, summary.summary);
    expect(context[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(context[0])).toContain('<summary>');

    // The next model call names the compaction and the kept range.
    sim.input('prompt', { text: 'third' });
    expect(sim.effectsOf('llm')[0]?.args).toMatchObject({
      compactionSeq: compaction?.seq,
      fromSeq: sim.snapshot.compaction?.firstKeptSeq,
    });
  });

  it('compacts at the end of a turn and before a prompt when over the threshold', () => {
    // A threshold of a few tokens: the context window minus almost all of it.
    const sim = start({ compaction: { keepRecentTokens: 1, reserveTokens: 999_990 } });
    sim.input('prompt', { text: 'first' });
    sim.ok(keyOf(sim, 'llm'), reply([text('one')]));

    // At the end of the turn: compact, then go idle.
    expect(sim.snapshot.phase).toMatchObject({
      kind: 'compacting',
      reason: 'threshold',
      thenContinue: false,
    });
    expect(sim.input('prompt', { text: 'too soon' }).rejected).not.toBeNull();
    sim.ok(keyOf(sim, 'summarize'), summary);
    expect(sim.snapshot.phase.kind).toBe('idle');

    // Before the next prompt's model call: compact, then call the model.
    sim.input('prompt', { text: 'second' });
    expect(sim.snapshot.phase).toMatchObject({
      kind: 'compacting',
      reason: 'threshold',
      thenContinue: true,
    });
    sim.ok(keyOf(sim, 'summarize'), summary);
    expect(sim.effectsOf('llm')).toHaveLength(1);
    // The new prompt was the newest entry, so it is kept.
    const kept = sim.state().log.entries.filter((entry) => entry.kind === 'user');
    expect(kept.at(-1)?.body).toMatchObject({ content: [text('second')] });
  });

  it('compacts once after a context overflow and calls the model again', () => {
    const sim = start({ compaction: { keepRecentTokens: 1 } });
    sim.input('prompt', { text: 'first' });
    sim.ok(keyOf(sim, 'llm'), reply([text('one')]));
    sim.input('prompt', { text: 'second' });
    sim.ok(keyOf(sim, 'llm'), failure('prompt is too long: 213462 tokens > 200000 maximum'));

    expect(sim.snapshot.phase).toMatchObject({ kind: 'compacting', reason: 'overflow' });
    sim.ok(keyOf(sim, 'summarize'), summary);
    expect(sim.effectsOf('llm')).toHaveLength(1);

    // A second overflow for the same prompt is not compacted again.
    sim.ok(keyOf(sim, 'llm'), failure('prompt is too long: 213462 tokens > 200000 maximum'));
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('goes idle with a notice when the summary fails', () => {
    const sim = start({ compaction: { keepRecentTokens: 1 } });
    sim.input('prompt', { text: 'first' });
    sim.ok(keyOf(sim, 'llm'), reply([text('one')]));
    sim.input('prompt', { text: 'second' });
    sim.ok(keyOf(sim, 'llm'), reply([text('two')]));
    sim.input('compact', {});
    sim.fail(keyOf(sim, 'summarize'), 'threw', 'model unavailable');
    expect(entries(sim, 'notice').at(-1)?.body).toEqual({
      level: 'error',
      text: 'Compaction failed: model unavailable',
    });
    expect(sim.snapshot.phase.kind).toBe('idle');
  });
});
