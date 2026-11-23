// Following an actor's conversation: each message once, where it stands after what came before
// it, and opened again from the last message when the stream is lost.

import type { ActorEvent, ConversationEntry } from '@acentric/protocol';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api.ts';
import { followConversation, type Standing, type StreamState } from '../src/agents/log/stream.ts';

const entry = (seq: number): ConversationEntry => ({
  seq,
  createdAt: seq,
  message: { role: 'user', content: [{ type: 'text', text: `message ${String(seq)}` }] },
});

const message = (seq: number): ActorEvent => ({ type: 'message', entry: entry(seq) });

async function* events(list: ActorEvent[], then?: Error): AsyncIterable<ActorEvent> {
  for (const event of list) yield event;
  if (then !== undefined) throw then;
}

describe('following a conversation', () => {
  it('gives each message once, standing after what came before it, and opens again from the last', async () => {
    const opened: number[] = [];
    const given: string[] = [];
    const states: StreamState[] = [];
    const abort = new AbortController();
    const standing: Standing = { status: 'idle', lastTurn: null, pendingInputs: 0 };
    const answers = [
      // Two messages: then the stream is lost.
      () => events([message(1), message(2)], new TypeError('lost')),
      () => events([message(2), message(3), { type: 'status', ...standing }]),
      () => {
        abort.abort();
        return events([], new Error('gone'));
      },
    ];
    await followConversation({
      open: (after) => {
        opened.push(after);
        const next = answers.shift();
        if (next === undefined) throw new Error('opened too often');
        return next();
      },
      after: 0,
      signal: abort.signal,
      onMessages: (messages) =>
        given.push(...messages.map((each) => `message ${String(each.seq)}`)),
      onStanding: (stood) => given.push(`status ${stood.status}`),
      onState: (state) => states.push(state),
      sleep: async () => undefined,
    });
    expect(given).toEqual(['message 1', 'message 2', 'message 3', 'status idle']);
    expect(opened).toEqual([0, 2, 3]);
    expect(states.slice(0, 4)).toEqual(['live', 'reconnecting', 'live', 'reconnecting']);
  });

  it('ends when no one is signed in, or for an actor that is not there', async () => {
    for (const status of [401, 403, 404]) {
      const states: StreamState[] = [];
      await followConversation({
        open: () => events([], new ApiError(status, { code: 'not_found', message: 'no' })),
        after: 0,
        signal: new AbortController().signal,
        onMessages: () => undefined,
        onStanding: () => undefined,
        onState: (state) => states.push(state),
      });
      expect(states).toEqual(['ended']);
    }
  });
});
