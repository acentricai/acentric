// The plans of a compaction: where a conversation is cut, what the model is asked, and what
// its answer leaves in place of the older part.

import { describe, expect, it } from 'vitest';

import type { ModelAnswer } from '@acentric/ai';
import { calls, compacted, says } from '@acentric/ai/testing';
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from '@acentric/protocol';

import {
  NoSummary,
  compactionNumbers,
  estimateTokens,
  planAll,
  planOlder,
  planSummary,
  tokensOf,
} from '../src/compaction.ts';
import type { Entry, Reader } from '../src/compaction.ts';

const user = (text: string): UserMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const answer = (text: string): AssistantMessage => says(text).message;
const called = calls({ id: 'c1', name: 'lookup', arguments: { id: 4411 } }).message;
const result = (text: string): ToolResultMessage => ({
  role: 'tool_result',
  toolCallId: 'c1',
  toolName: 'lookup',
  content: [{ type: 'text', text }],
});
/** A line of the engine's own. */
const line = (text: string): SystemMessage => ({
  role: 'system',
  content: [{ type: 'text', text }],
});

/** Messages as a conversation holds them: numbered from `from`. */
const stored = (messages: readonly Message[], from = 1): Entry[] =>
  messages.map((message, index) => ({ message, seq: from + index }));
const size = (...messages: Message[]): number =>
  messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);

/** How the provider of the tests is read. */
const reader: Reader = {
  read(message) {
    const parts = message.content as unknown as readonly {
      type: string;
      text?: string;
      name?: string;
      arguments?: unknown;
    }[];
    return {
      text: parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(''),
      toolCalls: parts
        .filter((part) => part.type === 'tool_call')
        .map((part) => ({ name: part.name ?? '', arguments: part.arguments })),
    };
  },
  compacted(message) {
    const left = message.content.filter((item) => item['type'] === 'compaction');
    return left.length === 1 ? { ...message, content: left } : undefined;
  },
};

/** What a plan's one message asks, for a plan that asks in text. */
const asked = (messages: readonly Message[]): string =>
  ((messages[0] as UserMessage).content[0] as { text: string }).text;

const long = (letter: string) => letter.repeat(400);
// A turn that looked an order up, and the start of the next.
const u1 = user(`Why two refunds? ${long('a')}`);
const r3 = result(`Refunded twice. ${long('b')}`);
const a4 = answer(`It was refunded twice. ${long('c')}`);
const u5 = user(`And order 7? ${long('d')}`);
const turn = [u1, called, r3, a4, u5];

describe('the size of a message', () => {
  it('is four characters a token of its text, and a thousand tokens for a part that is not text', () => {
    expect(estimateTokens(user('12345678'))).toBe(2);
    expect(estimateTokens(user('123456789'))).toBe(3);
    expect(
      estimateTokens({
        role: 'user',
        content: [
          { type: 'text', text: '1234' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        ],
      }),
    ).toBe(1001);
    expect(estimateTokens(result('1234'))).toBe(1);
  });

  it('is of all a provider wrote, for an answer', () => {
    const message = answer('1234');
    expect(estimateTokens(message)).toBe(Math.ceil(JSON.stringify(message.content).length / 4));
  });

  it('is what a provider counted, for a call: all it took in, and what it gave out', () => {
    expect(tokensOf({ totalInput: 80, input: 10, output: 30 })).toBe(110);
    expect(tokensOf({ input: 10, output: 30 })).toBe(40);
    expect(tokensOf({})).toBe(0);
    expect(tokensOf(undefined)).toBe(0);
  });
});

describe('the size a conversation may reach', () => {
  it('is four fifths of its model’s window, with 20,000 tokens of its end kept', () => {
    expect(compactionNumbers(undefined, { contextWindow: 400_000 })).toEqual({
      threshold: 320_000,
      reserve: 20_000,
      window: 400_000,
    });
  });

  it('is of a window of 200,000 tokens for a model whose window is not known', () => {
    expect(compactionNumbers(undefined, undefined)).toEqual({
      threshold: 160_000,
      reserve: 20_000,
      window: 200_000,
    });
  });

  it('is no more than the size from which the model’s every token costs more', () => {
    expect(
      compactionNumbers(undefined, { contextWindow: 1_000_000, dearerAbove: 200_000 }).threshold,
    ).toBe(200_000);
    expect(
      compactionNumbers(undefined, { contextWindow: 100_000, dearerAbove: 200_000 }).threshold,
    ).toBe(80_000);
  });

  it('is what the agent says, where it says', () => {
    expect(
      compactionNumbers({ threshold: 5, reserve: 0 }, { contextWindow: 400_000, dearerAbove: 1 }),
    ).toEqual({ threshold: 5, reserve: 0, window: 400_000 });
    expect(compactionNumbers({ reserve: 7 }, { contextWindow: 400_000 })).toMatchObject({
      threshold: 320_000,
      reserve: 7,
    });
  });
});

describe('a compaction by a provider that summarizes the older part', () => {
  const kept = (reserve: number, messages: readonly Message[] = turn) => {
    const plan = planOlder(stored(messages), reserve, messages.length + 1, reader);
    return plan === undefined
      ? undefined
      : {
          older: plan.messages.length,
          from: plan.finish(compacted('S')).keepFromSeq,
        };
  };

  it('asks the provider, with the actor’s own call, on the older part alone', () => {
    const plan = planOlder(stored(turn), size(u5), 6, reader);
    expect(plan).toMatchObject({ kind: 'older', ask: { by: 'provider' } });
    expect(plan?.messages).toEqual([u1, called, r3, a4]);
  });

  it('keeps as much of the end as the reserve is, cut where the model’s turn and another’s change over', () => {
    // The newest message is the reserve.
    expect(kept(size(u5))).toEqual({ older: 4, from: 5 });
    // A token more, and the answer before it is kept with it.
    expect(kept(size(u5) + 1)).toEqual({ older: 3, from: 4 });
    expect(kept(size(a4, u5))).toEqual({ older: 3, from: 4 });
  });

  it('never starts what is kept at a tool’s result: it starts after it, where it can', () => {
    expect(kept(size(a4, u5) + 1)).toEqual({ older: 3, from: 4 });
    expect(kept(size(r3, a4, u5))).toEqual({ older: 3, from: 4 });
    // The call is kept with its result.
    expect(kept(size(r3, a4, u5) + 1)).toEqual({ older: 1, from: 2 });
  });

  it('cuts before where the reserve is reached, when it can be cut nowhere after', () => {
    const again = user('Hello?');
    const messages = [u1, a4, u5, again];
    // Two messages of the user in a row are not parted.
    expect(kept(size(again), messages)).toEqual({ older: 2, from: 3 });
  });

  it('takes a line of the engine’s own as not the model’s, and one a provider takes as its own as no place to cut', () => {
    const own = line('<task-notification/>');
    expect(kept(size(own, u5), [u1, a4, own, u5])).toEqual({ older: 2, from: 3 });
    const level: SystemMessage = { ...own, providerOptions: { level: 'high' } };
    expect(kept(size(level, u5), [u1, a4, level, u5])).toEqual({ older: 1, from: 2 });
  });

  it('is nothing when all of the conversation is recent, or when it can be cut nowhere', () => {
    expect(kept(size(...turn) + 1)).toBeUndefined();
    expect(kept(1, [u1])).toBeUndefined();
    expect(kept(1, [])).toBeUndefined();
  });

  it('keeps of the answer the one block the provider wrote, as it came, and nothing else', () => {
    const plan = planOlder(stored(turn), size(u5), 6, reader);
    const block = { type: 'compaction', content: 'S', signature: 'sig' };
    const given: ModelAnswer = {
      ...compacted('S'),
      message: { ...compacted('S').message, content: [{ type: 'text', text: 'Here.' }, block] },
    };
    expect(plan?.finish(given)).toEqual({
      replacement: [{ ...given.message, content: [block] }],
      keepFromSeq: 5,
    });
  });

  it('has no summary in an answer with no block, or with more than one', () => {
    const plan = planOlder(stored(turn), size(u5), 6, reader);
    expect(() => plan?.finish(says('I would rather not.'))).toThrow(
      new NoSummary('The provider wrote no summary: the summarization ended with stop'),
    );
    const twice = compacted('S');
    const two: ModelAnswer = {
      ...twice,
      message: { ...twice.message, content: [...twice.message.content, ...twice.message.content] },
    };
    expect(() => plan?.finish(two)).toThrow(NoSummary);
  });

  it('sends what an earlier compaction left with what followed it, and is nothing when nothing followed', () => {
    const before: Entry = { message: compacted('Earlier.').message };
    const since = stored([u1, a4, u5], 5);
    const plan = planOlder([before, ...since], size(u5), 8, reader);
    expect(plan?.messages).toEqual([before.message, u1, a4]);
    expect(plan?.finish(compacted('S')).keepFromSeq).toBe(7);
    // What it left, alone, is not compacted again.
    expect(planOlder([before, ...stored([u5], 5)], 1, 6, reader)).toBeUndefined();
  });
});

describe('a compaction by a provider that compacts all it is sent', () => {
  const said = [u1, a4, u5, answer('Order 7 is fine.'), user('Thanks.')];

  it('asks the provider with all of the conversation, and is nothing for an empty one', () => {
    const plan = planAll(stored(said), 1, 6, reader);
    expect(plan).toMatchObject({ kind: 'all', ask: { by: 'provider' } });
    expect(plan?.messages).toEqual(said);
    expect(planAll([], 1, 1, reader)).toBeUndefined();
  });

  it('leaves the one item the provider returned, after the newest of what the user said that fits the reserve', () => {
    const item = compacted('opaque');
    const finish = (reserve: number) => planAll(stored(said), reserve, 6, reader)?.finish(item);
    // Nothing of the conversation follows the item as it was.
    expect(finish(0)).toEqual({ replacement: [item.message], keepFromSeq: 6 });
    expect(finish(size(user('Thanks.')))).toEqual({
      replacement: [user('Thanks.'), item.message],
      keepFromSeq: 6,
    });
    // In the order they were said. One that does not fit ends it: none older is kept past it.
    expect(finish(size(u5, user('Thanks.')))?.replacement).toEqual([
      u5,
      user('Thanks.'),
      item.message,
    ]);
    expect(finish(size(u1, u5, user('Thanks.')) - 1)?.replacement).toHaveLength(3);
    expect(finish(size(u1, u5, user('Thanks.')))?.replacement).toHaveLength(4);
    // A small one before a large one that does not fit is not kept without it.
    const hi = user('Hi.');
    const mixed = stored([hi, a4, u5, answer('Order 7 is fine.'), user('Thanks.')]);
    expect(planAll(mixed, size(hi, user('Thanks.')), 6, reader)?.finish(item).replacement).toEqual([
      user('Thanks.'),
      item.message,
    ]);
  });

  it('has no summary in an answer with nothing that stands for the conversation', () => {
    expect(() => planAll(stored(said), 1, 6, reader)?.finish(says('Hello.'))).toThrow(
      new NoSummary(
        'The provider answered a compaction with nothing that stands for the conversation',
      ),
    );
  });
});

describe('a compaction by a summary the model writes', () => {
  it('asks for text, with instructions of its own, showing the older part as what was said, called and returned', () => {
    const plan = planSummary(stored(turn), size(u5), 6, reader);
    expect(plan?.kind).toBe('summary');
    expect(plan?.ask).toEqual({
      by: 'summary',
      instructions: expect.stringMatching(/^You are a context summarization assistant\./) as string,
    });
    expect(plan?.messages).toHaveLength(1);
    const text = asked(plan?.messages ?? []);
    expect(text.startsWith('<conversation>\n[User]: Why two refunds? ')).toBe(true);
    expect(text).toContain('\n\n[Assistant tool calls]: lookup({"id":4411})\n\n');
    expect(text).toContain('\n\n[Tool result]: Refunded twice. ');
    expect(text).toContain('\n\n[Assistant]: It was refunded twice. ');
    expect(text).toContain(
      '\n</conversation>\n\nThe messages above are a conversation to summarize.',
    );
    expect(text).toContain('## Critical Context');
    // What is recent is not in it.
    expect(text).not.toContain('And order 7?');
  });

  it('leaves the summary as a message of the user, marked as one, before what is kept', () => {
    const plan = planSummary(stored(turn), size(u5), 6, reader);
    expect(plan?.finish(says('  ## Goal\nRefunds.\n'))).toEqual({
      replacement: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nRefunds.\n</summary>',
            },
          ],
          metadata: { compaction: 'summary' },
        },
      ],
      keepFromSeq: 5,
    });
  });

  it('keeps from where a turn starts, and inside a turn only when the turn is all that is recent', () => {
    const from = (reserve: number, messages: readonly Message[] = turn) =>
      planSummary(stored(messages), reserve, messages.length + 1, reader)?.finish(says('S'))
        .keepFromSeq;
    // Not from the answer: the summary would have what was asked, and the kept part its answer.
    expect(from(size(a4, u5))).toBe(5);
    expect(from(size(r3, a4, u5) + 1)).toBe(5);
    // One turn, and its end is all that is recent: from the answer, never from a tool's result.
    const one = [u1, called, r3, a4];
    expect(from(size(a4), one)).toBe(4);
    expect(from(size(r3, a4), one)).toBe(4);
    expect(from(size(called, r3, a4), one)).toBe(2);
    // Nothing after it to start from: all of it is summarized.
    expect(from(1, [u1, called, r3])).toBe(4);
  });

  it('is nothing when all of the conversation is recent', () => {
    expect(planSummary(stored(turn), size(...turn) + 1, 6, reader)).toBeUndefined();
    expect(planSummary([], 1, 1, reader)).toBeUndefined();
  });

  it('shows the summarizer the start of a long result of a tool, and says how much is left out', () => {
    const large = result('r'.repeat(2500));
    const text = asked(planSummary(stored([u1, called, large, u5]), 1, 5, reader)?.messages ?? []);
    expect(text).toContain(
      `[Tool result]: ${'r'.repeat(2000)}\n\n[... 500 more characters truncated]`,
    );
    expect(text).not.toContain('r'.repeat(2001));
  });

  it('shows only the end of an older part too long to be read whole, and says so', () => {
    const plan = planSummary(stored(turn), size(u5), 6, reader, 100);
    const text = asked(plan?.messages ?? []);
    const shown = text.slice('<conversation>\n'.length, text.indexOf('\n</conversation>'));
    expect(shown).toBe(
      `[... the oldest part of the conversation is left out: it was too long to read ...]\n\n${'c'.repeat(100)}`,
    );
  });

  it('updates a summary an earlier compaction left: it is not summarized again', () => {
    const first = planSummary(stored(turn), size(u5), 6, reader)?.finish(says('## Goal\nRefunds.'));
    const before: Entry = { message: first?.replacement[0] as Message };
    const since = stored([u5, answer('Order 7 is fine.'), user('Thanks.')], 5);
    const plan = planSummary([before, ...since], size(user('Thanks.')), 8, reader);
    const text = asked(plan?.messages ?? []);
    expect(text.startsWith('<conversation>\n[User]: And order 7? ')).toBe(true);
    expect(text).toContain(
      '\n</conversation>\n\n<previous-summary>\n## Goal\nRefunds.\n</previous-summary>\n\nThe messages above are NEW conversation messages to incorporate',
    );
    expect(text).not.toContain('compacted into the following summary');
    // The new one is all that stands for the older part.
    const done = plan?.finish(says('## Goal\nRefunds, and order 7.'));
    expect(done?.replacement).toHaveLength(1);
    expect(done?.keepFromSeq).toBe(7);
  });

  it('updates what a provider wrote, where it can be read', () => {
    const before: Entry = { message: compacted('They asked about order 4411.').message };
    const plan = planSummary([before, ...stored([u5, a4, u1], 5)], size(u1), 8, reader);
    expect(asked(plan?.messages ?? [])).toContain(
      '<previous-summary>\nThey asked about order 4411.\n</previous-summary>',
    );
    expect(plan?.finish(says('S')).replacement).toHaveLength(1);
  });

  it('leaves what a provider wrote that cannot be read where it is, before the summary', () => {
    const item: AssistantMessage = {
      ...says('').message,
      content: [{ type: 'compaction', encrypted_content: 'gAAAA' }],
    };
    const plan = planSummary([{ message: item }, ...stored([u5, a4, u1], 5)], size(u1), 8, reader);
    const text = asked(plan?.messages ?? []);
    expect(text).not.toContain('<previous-summary>');
    expect(text).toContain('The messages above are a conversation to summarize.');
    const done = plan?.finish(says('S'));
    expect(done?.replacement).toHaveLength(2);
    expect(done?.replacement[0]).toBe(item);
    expect(done?.replacement[1]).toMatchObject({
      role: 'user',
      metadata: { compaction: 'summary' },
    });
  });

  it('has no summary in an answer that was cut short, that ended otherwise, or that says nothing', () => {
    const plan = planSummary(stored(turn), size(u5), 6, reader);
    expect(() => plan?.finish({ ...says('## Goal'), stopReason: 'length' })).toThrow(
      new NoSummary(
        'The summarizer did not write a summary: it reached its output limit, so the summary is not whole',
      ),
    );
    expect(() => plan?.finish({ ...says('## Goal'), stopReason: 'refusal' })).toThrow(
      new NoSummary('The summarizer did not write a summary: it ended with refusal'),
    );
    expect(() => plan?.finish(says('  \n'))).toThrow(
      new NoSummary('The summarizer answered with no text'),
    );
  });
});
