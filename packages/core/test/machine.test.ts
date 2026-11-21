import { describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { Input, ToolResultMessage, TurnEnd } from '@acentric/protocol';

import { DEFAULT_RULES, OutOfTurn, decide } from '../src/machine.ts';
import type { MachineEvent, Rules } from '../src/machine.ts';
import { applyChange } from '../src/state.ts';
import type { ActorRecord, Turn } from '../src/state.ts';

const NOW = 1_795_305_600_000;
const source = (fill: number) => ({ now: NOW, random: new Uint8Array(10).fill(fill) });
const actor = makeId('actor', source(1));

/** An actor at `turn`, whose conversation has `said` messages. */
function at(turn: Turn, said = 0, lastTurn: TurnEnd | null = null): ActorRecord {
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
      lastTurn,
      pendingInputs: 0,
      createdAt: NOW,
      archivedAt: null,
    },
    turn,
    epoch: 0,
    nextSeq: said + 1,
  };
}

const IDLE: Turn = { phase: 'idle' };
const model = (more: Partial<Extract<Turn, { phase: 'model' }>> = {}): Turn => ({
  phase: 'model',
  startSeq: 1,
  attempt: 1,
  cutOffs: 0,
  retryAt: null,
  ...more,
});

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

/** Where the actor stands after the model made two tool calls, its answer the first message. */
const owing = (): ActorRecord => {
  const start = at(model(), 0);
  return applyChange(start, decide(start, { type: 'answered', answer: two }, NOW), 0);
};

const failed = (retryable: boolean, retryAfterMs?: number): MachineEvent => ({
  type: 'model_failed',
  reason: 'overloaded',
  retryable,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

describe('a turn starts', () => {
  it('with the mail, in the order it came', () => {
    const first = input(10, 'one');
    const second = input(11, 'two');
    const change = decide(at(IDLE, 4), { type: 'wake', inputs: [first, second] }, NOW);

    expect(change.turn).toEqual(model({ startSeq: 5 }));
    expect(change.status).toBe('working');
    expect(change.append.map((entry) => entry.seq)).toEqual([5, 6]);
    expect(change.append[1]?.input).toEqual({ id: second.id, type: 'message' });
    expect(change.deliver).toEqual([first.id, second.id]);
  });

  it('again with nothing new, when a person asks for a failed turn to be tried again', () => {
    const lastTurn = { end: 'failed', at: NOW, reason: 'overloaded' } as const;
    const change = decide(at(IDLE, 3, lastTurn), { type: 'retry' }, NOW);
    expect(change.turn).toEqual(model({ startSeq: 4 }));
    expect(change.append).toEqual([]);
    expect(() => decide(at(IDLE, 3, { end: 'ok', at: NOW }), { type: 'retry' }, NOW)).toThrow(
      OutOfTurn,
    );
  });
});

describe('the model answers', () => {
  it('with tool calls: each is owed', () => {
    const change = decide(at(model()), { type: 'answered', answer: two }, NOW);
    expect(change.turn).toEqual({
      phase: 'tools',
      startSeq: 1,
      calls: [
        { id: 'c1', name: 'lookup_order', arguments: { id: 1 }, result: null },
        { id: 'c2', name: 'lookup_order', arguments: { id: 2 }, result: null },
      ],
    });
    expect(change.append.map((entry) => entry.message.role)).toEqual(['assistant']);
    expect(change.append[0]?.completion?.stopReason).toBe('tool_use');
  });

  it('with none: the turn ends', () => {
    const change = decide(at(model()), { type: 'answered', answer: says('Done.') }, NOW);
    expect(change.turn).toEqual(IDLE);
    expect(change.status).toBe('idle');
    expect(change.lastTurn).toEqual({ end: 'ok', at: NOW });
  });

  it('having paused in work of its provider’s own: its answer is kept, and it is called again', () => {
    const answer = { ...says('Searching.'), stopReason: 'pause_turn' as const };
    const change = decide(
      at(model({ startSeq: 3, attempt: 2 }), 4),
      { type: 'answered', answer },
      NOW,
    );
    expect(change.turn).toEqual(model({ startSeq: 3 }));
    expect(change.status).toBe('working');
    expect(change.append.map((entry) => entry.message.role)).toEqual(['assistant']);
  });

  it('by declining: the turn is refused, and everything of it is left out from then on', () => {
    const answer = { ...says('I cannot help with that.'), stopReason: 'refusal' as const };
    const change = decide(at(model({ startSeq: 3 }), 4), { type: 'answered', answer }, NOW);
    expect(change.lastTurn).toMatchObject({ end: 'refused' });
    expect(change.leaveOutFrom).toBe(3);
    expect(change.append.map((entry) => [entry.seq, entry.leftOut])).toEqual([[5, true]]);
  });
});

describe('a call of the model fails', () => {
  const rules: Rules = {
    ...DEFAULT_RULES,
    retry: { maxAttempts: 3, initialDelayMs: 1000, factor: 2, maxDelayMs: 2500 },
  };

  it('in a way that may pass: it is owed again, later each time, up to the longest wait', () => {
    const waits = [1, 2].map((attempt) => {
      const change = decide(at(model({ attempt })), failed(true), NOW, rules);
      return change.turn.phase === 'model' ? [change.turn.attempt, change.turn.retryAt] : null;
    });
    expect(waits).toEqual([
      [2, NOW + 1000],
      [3, NOW + 2000],
    ]);
    const capped = decide(at(model({ attempt: 2 })), failed(true), NOW, {
      ...rules,
      retry: { ...rules.retry, initialDelayMs: 2000 },
    });
    expect(capped.turn).toMatchObject({ retryAt: NOW + 2500 });
  });

  it('and the provider said how long to wait: that long', () => {
    const change = decide(at(model()), failed(true, 7000), NOW, rules);
    expect(change.turn).toMatchObject({ attempt: 2, retryAt: NOW + 7000 });
  });

  it('for the last time it is tried: the turn fails, with why', () => {
    const change = decide(at(model({ attempt: 3 })), failed(true), NOW, rules);
    expect(change.turn).toEqual(IDLE);
    expect(change.lastTurn).toEqual({ end: 'failed', at: NOW, reason: 'overloaded' });
  });

  it('in a way that will not pass: the turn fails at once', () => {
    const change = decide(at(model()), failed(false), NOW, rules);
    expect(change.lastTurn?.end).toBe('failed');
  });
});

describe('a restart finds the call of the model owed', () => {
  it('and it is owed again, counted', () => {
    const change = decide(at(model({ cutOffs: 2 })), { type: 'cut_off' }, NOW);
    expect(change.turn).toEqual(model({ cutOffs: 3 }));
  });

  it('too many times: the turn fails, so that a call that ends the process is not made for ever', () => {
    const rules = { ...DEFAULT_RULES, maxCutOffs: 2 };
    const change = decide(at(model({ cutOffs: 2 })), { type: 'cut_off' }, NOW, rules);
    expect(change.lastTurn).toMatchObject({
      end: 'failed',
      reason: expect.stringContaining('3 times') as string,
    });
  });
});

describe('tools answer', () => {
  it('one of several: its result is kept with the turn, and nothing is said yet', () => {
    const change = decide(
      owing(),
      { type: 'tool_finished', call: 'c2', result: result('c2', 'two'), inputs: [] },
      NOW,
    );
    expect(change.append).toEqual([]);
    expect(change.turn).toMatchObject({ phase: 'tools' });
  });

  it('the last: the results go in by the order of the calls, with the mail, and it is the model’s turn', () => {
    const start = owing();
    const second = applyChange(
      start,
      decide(
        start,
        { type: 'tool_finished', call: 'c2', result: result('c2', 'two'), inputs: [] },
        NOW,
      ),
      0,
    );
    const late = input(12, 'and another thing');
    const back = decide(
      second,
      { type: 'tool_finished', call: 'c1', result: result('c1', 'one'), inputs: [late] },
      NOW,
    );

    expect(back.turn).toEqual(model({ startSeq: 1 }));
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
});

describe('a person interrupts', () => {
  it('a call of the model: the turn ends, and nothing of the call is kept', () => {
    const change = decide(at(model(), 1), { type: 'interrupted' }, NOW);
    expect(change.turn).toEqual(IDLE);
    expect(change.lastTurn).toEqual({ end: 'interrupted', at: NOW });
    expect(change.append).toEqual([]);
  });

  it('tool calls: each has an answer, and one that had none says it was stopped', () => {
    const start = owing();
    const one = applyChange(
      start,
      decide(
        start,
        { type: 'tool_finished', call: 'c1', result: result('c1', 'one'), inputs: [] },
        NOW,
      ),
      0,
    );
    const change = decide(one, { type: 'interrupted' }, NOW);

    expect(change.lastTurn?.end).toBe('interrupted');
    const results = change.append.map((entry) => entry.message as ToolResultMessage);
    expect(results.map((message) => [message.toolCallId, message.isError ?? false])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
  });
});

describe('archiving', () => {
  it('puts an idle actor away, and brings it back', () => {
    const last = { end: 'ok', at: NOW - 5 } as const;
    const idle = at(IDLE, 2, last);
    const away = decide(idle, { type: 'archive' }, NOW);
    expect(away).toMatchObject({ status: 'archived', archivedAt: NOW, lastTurn: last });

    const back = decide(applyChange(idle, away, 0), { type: 'unarchive' }, NOW + 1);
    expect(back).toMatchObject({ status: 'idle', archivedAt: null, lastTurn: last });
  });
});

describe('what does not follow from where the actor stands', () => {
  it('is refused', () => {
    const archived = applyChange(at(IDLE), decide(at(IDLE), { type: 'archive' }, NOW), 0);
    const refused: [ActorRecord, MachineEvent][] = [
      [at(IDLE), { type: 'answered', answer: says('Hello.') }],
      [at(IDLE), { type: 'wake', inputs: [] }],
      [at(IDLE), { type: 'interrupted' }],
      [at(IDLE), { type: 'unarchive' }],
      [at(model()), { type: 'wake', inputs: [input(13, 'x')] }],
      [at(model()), { type: 'archive' }],
      [at(model()), { type: 'tool_finished', call: 'c1', result: result('c1', 'x'), inputs: [] }],
      [owing(), { type: 'answered', answer: says('Hello.') }],
      [owing(), { type: 'cut_off' }],
      [
        owing(),
        { type: 'tool_finished', call: 'c9', result: result('c9', 'none such'), inputs: [] },
      ],
      // An actor that was put away takes no mail.
      [archived, { type: 'wake', inputs: [input(14, 'x')] }],
    ];
    for (const [record, event] of refused) {
      expect(
        () => decide(record, event, NOW),
        `${event.type} at ${record.actor.status}, ${record.turn.phase}`,
      ).toThrow(OutOfTurn);
    }
  });
});
