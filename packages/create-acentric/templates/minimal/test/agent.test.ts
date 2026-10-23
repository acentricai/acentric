// The pure half, tested without a runner: the simulator delivers messages to
// step one at a time and plays the effects by hand.

import { simulate } from '@acentric/testing';
import { describe, expect, it } from 'vitest';

import agent from '../src/agent.js';

describe('notes', () => {
  it('adds notes and marks them done', () => {
    const sim = simulate(agent, {});
    sim.input('add', { text: 'buy milk' });
    sim.input('add', { text: 'call home' });
    sim.input('done', { id: 1 });
    expect(sim.log.map((entry) => entry.kind)).toEqual(['added', 'added', 'done']);
    expect(agent.view?.(sim.state())).toEqual({ open: 1, done: 1, reminders: 0 });
  });

  it('rejects what it cannot do, changing nothing', () => {
    const sim = simulate(agent, {});
    expect(sim.input('add', { text: '  ' }).rejected).toBe('add needs some text');
    expect(sim.input('done', { id: 7 }).rejected).toBe('no note 7');
    expect(sim.input('shout', {}).rejected).toMatch(/unknown input shout/);
    expect(sim.log).toEqual([]);
  });

  it('reminds you of a note when its timer fires', () => {
    const sim = simulate(agent, {});
    sim.input('add', { text: 'buy milk' });
    const remind = sim.input('remind', { id: 1, inSeconds: 30 });
    expect(remind.started).toEqual([
      { key: 'remind:1:30000', kind: '@timer', args: { at: 30000 } },
    ]);

    sim.advance(30_000);
    sim.ok('remind:1:30000', null);
    expect(sim.log.at(-1)).toMatchObject({ kind: 'reminder', body: { id: 1, text: 'buy milk' } });
    expect(sim.running).toEqual([]);
  });
});
