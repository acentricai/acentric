// Inputs: rejections, the steer and follow-up queues, and settings changes.

import { describe, expect, it } from 'vitest';

import { call, entries, keyOf, reply, start, text, toolOk } from './helpers.js';

describe('inputs', () => {
  it('rejects a prompt while a run is going, and starts a run from a steer while idle', () => {
    const sim = start();
    expect(sim.input('steer', { text: 'hi' }).rejected).toBeNull();
    expect(entries(sim, 'user')[0]?.body).toEqual({ content: [text('hi')], via: 'steer' });
    expect(sim.input('prompt', { text: 'again' }).rejected).toBe(
      'busy: a run is going, so send steer or follow_up instead',
    );
  });

  it('rejects unknown kinds, such as pause, and bad payloads', () => {
    const sim = start();
    expect(sim.input('dance', {}).rejected).toBe('unknown input kind dance');
    expect(sim.input('pause', {}).rejected).toBe('unknown input kind pause');
    expect(sim.input('prompt', { text: 3 }).rejected).toBe('text must be a string');
    expect(sim.log).toHaveLength(2);
  });

  it('gives steering to the model after the tool calls, and follow-ups only when the run would end', () => {
    const sim = start();
    sim.input('prompt', { text: 'start' });
    sim.input('steer', { text: 'also check b' });
    sim.input('follow_up', { text: 'then summarise' });
    expect(entries(sim, 'queued')).toHaveLength(2);

    sim.ok(keyOf(sim, 'llm'), reply([call('c1', 'read', { path: 'a' })]));
    sim.ok(keyOf(sim, 'read'), toolOk('a'));
    // The steer is injected before the next model call; the follow-up waits.
    expect(entries(sim, 'user').map((entry) => entry.body)).toEqual([
      { content: [text('start')], via: 'prompt' },
      { content: [text('also check b')], via: 'steer' },
    ]);
    expect(sim.snapshot.followUps).toHaveLength(1);

    sim.ok(keyOf(sim, 'llm'), reply([text('checked')]));
    expect(entries(sim, 'user').at(-1)?.body).toEqual({
      content: [text('then summarise')],
      via: 'follow_up',
    });
    expect(sim.effectsOf('llm')).toHaveLength(1);

    sim.ok(keyOf(sim, 'llm'), reply([text('summary')]));
    expect(sim.snapshot.phase.kind).toBe('idle');
  });

  it("injects every queued message at once in 'all' mode", () => {
    const sim = start({ steeringMode: 'all' });
    sim.input('prompt', { text: 'start' });
    sim.input('steer', { text: 'one' });
    sim.input('steer', { text: 'two' });
    sim.ok(keyOf(sim, 'llm'), reply([call('c1', 'read', { path: 'a' })]));
    sim.ok(keyOf(sim, 'read'), toolOk('a'));
    expect(entries(sim, 'user').map((entry) => entry.body)).toHaveLength(3);
    expect(sim.snapshot.steering).toEqual([]);
  });

  it('keeps queued messages in the window until they are injected', () => {
    const sim = start();
    sim.input('prompt', { text: 'start' });
    sim.input('follow_up', { text: 'later' });
    const queued = entries(sim, 'queued')[0]?.seq ?? 0;
    expect(sim.state().log.start).toBeLessThanOrEqual(queued);
  });

  it('changes the model and thinking level from the next call on', () => {
    const sim = start();
    expect(sim.input('set_model', { provider: 'acme', id: 'nope' }).rejected).toBe(
      'unknown model acme/nope',
    );
    sim.input('set_model', { provider: 'openai', id: 'gpt-5.5' });
    sim.input('set_thinking', { level: 'high' });
    expect(entries(sim, 'model_change').at(-1)?.body).toEqual({
      model: { provider: 'openai', id: 'gpt-5.5' },
    });

    sim.input('prompt', { text: 'hi' });
    expect(sim.effectsOf('llm')[0]?.args).toMatchObject({
      model: { provider: 'openai', id: 'gpt-5.5' },
      thinkingLevel: 'high',
    });
  });

  it('accepts images for a model that can see them', () => {
    const sim = start();
    const image = { type: 'image', data: 'aGk=', mimeType: 'image/png' };
    expect(sim.input('prompt', { text: 'look', images: [image] }).rejected).toBeNull();
    expect(entries(sim, 'user')[0]?.body).toMatchObject({ content: [text('look'), image] });
  });
});
