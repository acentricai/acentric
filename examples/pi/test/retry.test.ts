// Retrying failed model calls with backoff.

import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/index.js';
import { entries, failure, keyOf, reply, start, text } from './helpers.js';

describe('retry', () => {
  it('waits with doubling delays, hides failed attempts from the model, and calls again', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });

    sim.ok(keyOf(sim, 'llm'), failure('503 Service Unavailable'));
    expect(sim.effectsOf('@timer')[0]?.args).toEqual({ at: sim.now + 2_000 });
    expect(entries(sim, 'notice')[0]?.body).toMatchObject({ level: 'warning' });

    sim.advance(2_000);
    sim.ok(keyOf(sim, '@timer'), null);
    sim.ok(keyOf(sim, 'llm'), failure('fetch failed'));
    expect(sim.effectsOf('@timer')[0]?.args).toEqual({ at: sim.now + 4_000 });

    sim.ok(keyOf(sim, '@timer'), null);
    sim.ok(keyOf(sim, 'llm'), reply([text('finally')]));
    expect(sim.snapshot.retries).toBe(0);
    expect(sim.snapshot.phase.kind).toBe('idle');

    const context = buildContext(sim.log, null);
    expect(context.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('gives up after the last retry and leaves the error in the conversation', () => {
    const sim = start({ retry: { maxRetries: 1 } });
    sim.input('prompt', { text: 'go' });
    sim.ok(keyOf(sim, 'llm'), failure('overloaded'));
    sim.ok(keyOf(sim, '@timer'), null);
    sim.ok(keyOf(sim, 'llm'), failure('overloaded'));
    expect(sim.snapshot.phase.kind).toBe('idle');
    expect(entries(sim, 'assistant').at(-1)?.body).toMatchObject({ stopReason: 'error' });
  });

  it('does not retry errors that will not pass, such as quota exhaustion', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.ok(keyOf(sim, 'llm'), failure('429 insufficient_quota'));
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it('treats a failing llm handler as a failed reply', () => {
    const sim = start();
    sim.input('prompt', { text: 'go' });
    sim.fail(keyOf(sim, 'llm'), 'timeout', 'request timed out');
    expect(entries(sim, 'assistant')[0]?.body).toMatchObject({
      stopReason: 'error',
      errorMessage: 'request timed out',
    });
    expect(sim.effectsOf('@timer')).toHaveLength(1);
  });
});
