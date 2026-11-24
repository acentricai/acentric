// The bus an actor's events are told on: what one listener does is never another's, nor the
// teller's.

import { describe, expect, it } from 'vitest';

import type { ActorEvent, ActorId } from '@acentric/protocol';

import { MemoryBus } from '../src/index.ts';

const ACTOR = 'act_1' as ActorId;
const EVENT = { type: 'status', status: 'idle', lastTurn: null, pendingInputs: 0 } as ActorEvent;

describe('the memory bus', () => {
  it('tells every listener when one fails, and says the failure without throwing it', () => {
    const reported: unknown[] = [];
    const bus = new MemoryBus({ report: (error) => reported.push(error) });
    const told: string[] = [];
    bus.subscribe(ACTOR, () => {
      told.push('first');
    });
    bus.subscribe(ACTOR, () => {
      throw new TypeError('Invalid state: Controller is already closed');
    });
    bus.subscribe(ACTOR, () => {
      told.push('third');
    });
    expect(() => {
      bus.publish(ACTOR, EVENT);
    }).not.toThrow();
    expect(told).toEqual(['first', 'third']);
    expect(reported).toHaveLength(1);
  });

  it('tells those listening as it began, when one stops listening as it is told', () => {
    const bus = new MemoryBus();
    const told: string[] = [];
    let stop = () => {};
    stop = bus.subscribe(ACTOR, () => {
      told.push('first');
      stop();
    });
    bus.subscribe(ACTOR, () => {
      told.push('second');
    });
    bus.publish(ACTOR, EVENT);
    bus.publish(ACTOR, EVENT);
    expect(told).toEqual(['first', 'second', 'second']);
  });
});
