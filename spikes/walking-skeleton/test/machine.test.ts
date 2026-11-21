import { describe, expect, it } from 'vitest';

import { makeId } from '@acentric/protocol';
import type { Input, ToolResultMessage } from '@acentric/protocol';

import { calls, says } from '../src/fakes.ts';
import type { ActorRecord, Turn } from '../src/interfaces.ts';
import { OutOfTurn, decide } from '../src/machine.ts';

const NOW = 1_795_305_600_000;
const source = (fill: number) => ({ now: NOW, random: new Uint8Array(10).fill(fill) });
const actor = makeId('actor', source(1));

/** An actor at `turn`, whose conversation has `said` messages. */
function at(turn: Turn, said = 0): ActorRecord {
  return {
    actor: {
      id: actor,
      name: null,
      externalId: null,
      agent: makeId('agent', source(2)),
      deployment: { id: makeId('deployment', source(3)), version: 1 },
      model: 'fake-1',
      reasoning: 'medium',
      configuration: null,
      status: turn.phase === 'idle' ? 'idle' : 'working',
      lastTurn: null,
      pendingInputs: 0,
      createdAt: NOW,
      archivedAt: null,
    },
    turn,
    epoch: 0,
    nextSeq: said + 1,
  };
}

function input(fill: number, text: string): Input {
  return {
    id: makeId('input', source(fill)),
    actor,
    type: 'message',
    externalId: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
    receivedAt: NOW,
    deliveredAt: null,
  };
}

const result = (call: string, text: string): ToolResultMessage => ({
  role: 'tool_result',
  toolCallId: call,
  toolName: 'lookup_order',
  content: [{ type: 'text', text }],
});

const two = calls(
  { id: 'c1', name: 'lookup_order', arguments: { id: 1 } },
  { id: 'c2', name: 'lookup_order', arguments: { id: 2 } },
);

describe('decide', () => {
  it('starts a turn with the mail, in the order it came', () => {
    const first = input(10, 'one');
    const second = input(11, 'two');
    const change = decide(at({ phase: 'idle' }, 4), { type: 'wake', inputs: [first, second] }, NOW);

    expect(change.turn).toEqual({ phase: 'model' });
    expect(change.status).toBe('working');
    expect(change.append.map((entry) => entry.seq)).toEqual([5, 6]);
    expect(change.append[1]?.input).toEqual({ id: second.id, type: 'message' });
    expect(change.deliver).toEqual([first.id, second.id]);
  });

  it('owes every tool call of an answer that made some', () => {
    const change = decide(at({ phase: 'model' }), { type: 'answered', answer: two }, NOW);
    expect(change.turn).toEqual({
      phase: 'tools',
      calls: [
        { id: 'c1', name: 'lookup_order', arguments: { id: 1 }, result: null },
        { id: 'c2', name: 'lookup_order', arguments: { id: 2 }, result: null },
      ],
    });
    expect(change.append.map((entry) => entry.message.role)).toEqual(['assistant']);
  });

  it('ends the turn on an answer that made none', () => {
    const change = decide(at({ phase: 'model' }), { type: 'answered', answer: says('Done.') }, NOW);
    expect(change.turn).toEqual({ phase: 'idle' });
    expect(change.status).toBe('idle');
    expect(change.lastTurn).toEqual({ end: 'ok', at: NOW });
  });

  it('ends the turn as refused when the model declined', () => {
    const answer = { ...says('I cannot help with that.'), stopReason: 'refusal' as const };
    const change = decide(at({ phase: 'model' }), { type: 'answered', answer }, NOW);
    expect(change.lastTurn).toEqual({ end: 'refused', at: NOW });
  });

  it('puts the results in the conversation in the order of the calls, whichever ended first', () => {
    const owing = decide(at({ phase: 'model' }), { type: 'answered', answer: two }, NOW).turn;
    const second = decide(
      at(owing, 1),
      { type: 'tool_finished', call: 'c2', result: result('c2', 'two') },
      NOW,
    );
    expect(second.append).toEqual([]);
    const first = decide(
      at(second.turn, 1),
      { type: 'tool_finished', call: 'c1', result: result('c1', 'one') },
      NOW,
    );

    const late = input(12, 'and another thing');
    const back = decide(at(first.turn, 1), { type: 'continue', inputs: [late] }, NOW);
    expect(back.turn).toEqual({ phase: 'model' });
    expect(back.append.map((entry) => [entry.seq, entry.message.role])).toEqual([
      [2, 'tool_result'],
      [3, 'tool_result'],
      [4, 'user'],
    ]);
    expect(
      back.append.slice(0, 2).map((entry) => (entry.message as ToolResultMessage).toolCallId),
    ).toEqual(['c1', 'c2']);
    expect(back.deliver).toEqual([late.id]);
  });

  it('refuses what does not follow from where the actor stands', () => {
    const owing = decide(at({ phase: 'model' }), { type: 'answered', answer: two }, NOW).turn;
    const refused: [Turn, Parameters<typeof decide>[1]][] = [
      [{ phase: 'idle' }, { type: 'answered', answer: says('Hello.') }],
      [{ phase: 'idle' }, { type: 'wake', inputs: [] }],
      [{ phase: 'model' }, { type: 'wake', inputs: [input(13, 'x')] }],
      [{ phase: 'model' }, { type: 'continue', inputs: [] }],
      // A result is still owed.
      [owing, { type: 'continue', inputs: [] }],
      [owing, { type: 'tool_finished', call: 'c9', result: result('c9', 'none such') }],
    ];
    for (const [turn, event] of refused) {
      expect(() => decide(at(turn), event, NOW), `${event.type} at ${turn.phase}`).toThrow(
        OutOfTurn,
      );
    }
  });
});
