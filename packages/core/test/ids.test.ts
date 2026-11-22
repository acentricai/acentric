import { describe, expect, it } from 'vitest';

import { parseId } from '@acentric/protocol';

import { IdSource } from '../src/ids.ts';

const NOW = 1_795_305_600_000;

describe('IDs from one source', () => {
  it('sort in the order they were made, however many are made in one millisecond', () => {
    const ids = new IdSource(() => crypto.getRandomValues(new Uint8Array(10)));
    const made = Array.from({ length: 2000 }, (_, index) =>
      ids.make('actor', NOW + Math.floor(index / 500)),
    );
    expect(made.toSorted()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });

  it('go on from the last when the clock goes back, and say the later time', () => {
    const ids = new IdSource(() => new Uint8Array(10).fill(7));
    const first = ids.make('input', NOW);
    const second = ids.make('input', NOW - 5000);
    expect(second > first).toBe(true);
    expect(parseId(second)).toEqual({ kind: 'input', createdAt: NOW });
  });

  it('take the next millisecond when a millisecond has no room left', () => {
    const ids = new IdSource(() => new Uint8Array(10).fill(255));
    const first = ids.make('input', NOW);
    const second = ids.make('input', NOW);
    expect(second > first).toBe(true);
    expect(parseId(second)).toEqual({ kind: 'input', createdAt: NOW + 1 });
  });

  it('are of the kind asked for, across kinds, in one order', () => {
    const ids = new IdSource(() => crypto.getRandomValues(new Uint8Array(10)));
    const agent = ids.make('agent', NOW);
    const actor = ids.make('actor', NOW);
    expect(agent.startsWith('agt_')).toBe(true);
    expect(actor.startsWith('act_')).toBe(true);
    expect(actor.slice(4) > agent.slice(4)).toBe(true);
  });
});
