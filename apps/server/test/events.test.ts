// The stream of one who follows an actor, when the actor's turn ends just as the stream
// starts: what is sent is in the order it happened.

import { describe, expect, it } from 'vitest';

import { MemoryBus } from '@acentric/core';
import type { Engine } from '@acentric/core';
import type { Actor, ActorEvent, ConversationEntry } from '@acentric/protocol';

import { Streams } from '../src/index.ts';

describe('one who follows an actor from a place in its conversation', () => {
  it('is sent the last message of a turn before being told the turn has ended, whenever the turn ends', async () => {
    const actor = { id: 'act_1' } as unknown as Actor;
    const answer = {
      seq: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'It was refunded twice.' }] },
    } as unknown as ConversationEntry;
    const bus = new MemoryBus();
    let entries: ConversationEntry[] = [];
    let now = { status: 'working', lastTurn: null as unknown, pendingInputs: 0 };
    let reads = 0;
    // The turn ends between the first thing the stream reads and the second.
    const read = <T>(value: T): T => {
      reads += 1;
      if (reads === 1) {
        queueMicrotask(() => {
          entries = [answer];
          now = { status: 'idle', lastTurn: { end: 'ok' }, pendingInputs: 0 };
          bus.publish(actor.id, { type: 'message', entry: answer });
          bus.publish(actor.id, { type: 'status', ...now } as ActorEvent);
        });
      }
      return value;
    };
    const engine = {
      bus,
      conversation: async () => read(entries),
      getActor: async () => read({ ...now }),
    } as unknown as Engine;

    const given = new AbortController();
    const request = new Request('http://engine.test/v1/actors/act_1/events', {
      signal: given.signal,
    });
    const response = new Streams().follow(engine, actor, 3, request);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    const sent = (): string[] =>
      text
        .split('\n\n')
        .filter((frame) => frame.includes('data: '))
        .map((frame) => {
          const event = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as {
            type: string;
            status?: string;
            entry?: { seq: number };
          };
          return event.type === 'message'
            ? `message ${String(event.entry?.seq)}`
            : String(event.status);
        });
    while (!sent().includes('idle')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    given.abort();
    // Once, and before the word that the turn is over.
    expect(sent().filter((one) => one === 'message 4')).toHaveLength(1);
    expect(sent().indexOf('message 4')).toBeLessThan(sent().indexOf('idle'));
  });
});
