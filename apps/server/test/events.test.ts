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

describe('one who comes back to a long conversation', () => {
  it('is sent a page of it at a time, as they read, not all of it at once', async () => {
    const actor = { id: 'act_1' } as unknown as Actor;
    const all = Array.from(
      { length: 1_600 },
      (_, index) =>
        ({
          seq: index + 1,
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Message ${String(index + 1)}` }],
          },
        }) as unknown as ConversationEntry,
    );
    const pages: number[] = [];
    const engine = {
      bus: new MemoryBus(),
      conversation: async (_: unknown, { after, limit }: { after: number; limit: number }) => {
        pages.push(after);
        return all.filter((entry) => entry.seq > after).slice(0, limit);
      },
      getActor: async () => ({ status: 'idle', lastTurn: null, pendingInputs: 0 }),
    } as unknown as Engine;
    const given = new AbortController();
    const request = new Request('http://engine.test/v1/actors/act_1/events', {
      signal: given.signal,
    });
    const response = new Streams().follow(engine, actor, 0, request);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    // Nothing is read: one page is sent, and the next waits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pages).toEqual([0]);

    // Read, every page comes, and then where the actor stands.
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"status"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    given.abort();
    expect(pages).toEqual([0, 500, 1_000, 1_500]);
    expect(text.split('event: message').length - 1).toBe(1_600);
  });
});
