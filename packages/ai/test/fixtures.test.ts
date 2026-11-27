// Every provider, held to what was recorded of the real one: it sends what was sent then, and
// makes of the answer what was made of it then. A provider that is added records the same
// scenarios, and is held to the same.

import { describe, expect, it } from 'vitest';

import { ModelFailure, builtInProviders } from '../src/index.ts';
import type { ModelAnswer } from '../src/index.ts';
import { answering, credentialFor, fixture, fixturesOf } from './replay.ts';

const providers = builtInProviders();
const signal = () => new AbortController().signal;

describe.each(providers.list().map((provider) => provider.id))(
  '%s, against what was recorded',
  (id) => {
    const provider = providers.get(id);
    const run = async (scenario: string) => {
      const recorded = fixture(id, scenario);
      const { fetch, sent } = answering(recorded.response);
      const answer = await provider
        .runner({ credential: credentialFor(id), fetch })
        .run(recorded.step, signal());
      return { recorded, sent, answer };
    };

    /** Whether the provider has a web search of its own. */
    const searches = id !== 'fireworks';

    it('has every scenario recorded', () => {
      expect(fixturesOf(id).map((one) => one.scenario)).toEqual([
        'bad-key',
        ...(provider.compacts === undefined ? [] : ['compaction-next', 'compaction']),
        'text',
        'tool-call',
        'tool-result',
        'unknown-model',
        ...(searches ? ['web-search-next', 'web-search'] : []),
      ]);
    });

    it.runIf(provider.compacts !== undefined)(
      'compacts a conversation itself when asked, and answers with what stands for it',
      async () => {
        const { recorded, sent, answer } = await run('compaction');
        expect(recorded.step.compact).toBe(true);
        expect(sent).toEqual([recorded.request]);
        expect(answer).toEqual((recorded.expected as { answer: ModelAnswer }).answer);
        expect(answer.toolCalls).toEqual([]);
        const left = provider.compacted?.(answer.message);
        expect(left?.content).toHaveLength(1);
        expect(left?.content[0]?.['type']).toBe('compaction');
        // Compacted on the server before it answered, a plan's answer has what stands for the
        // conversation first, and an answer after it that is no part of what is kept. Elsewhere
        // it answered nothing: all there is in it is what stands for the conversation.
        const onServer = id === 'chatgpt';
        expect(onServer ? answer.message.content[0] : left?.content[0]).toEqual(left?.content[0]);
        expect(provider.read(answer.message).text === '').toBe(!onServer);
        // And it is exactly as it came: it is signed, or cannot be read at all.
        expect(answer.message.content).toContainEqual(left?.content[0]);
        // The call is paid for like any other.
        expect(answer.usage?.cost?.total).toBeGreaterThan(0);
        // An answer that is no compaction has nothing of the kind in it.
        expect(provider.compacted?.((await run('text')).answer.message)).toBeUndefined();
      },
    );

    it.runIf(provider.compacts !== undefined)(
      'goes on from what a compaction left, and keeps the reasoning of the turns after it',
      async () => {
        const { answer: compacted } = await run('compaction');
        const { recorded, sent, answer } = await run('compaction-next');
        expect(sent).toEqual([recorded.request]);
        const body = JSON.stringify(sent[0]?.body);
        // What stands for the conversation is sent as it came.
        const [left] = provider.compacted?.(compacted.message)?.content ?? [];
        expect(body).toContain(JSON.stringify(left));
        // Every answer that is sent after it is sent whole, its reasoning included: the
        // provider took them, which is what this was recorded to show.
        const kept = recorded.step.messages.flatMap((message) =>
          message.role === 'assistant' && provider.compacted?.(message) === undefined
            ? [message]
            : [],
        );
        for (const message of kept) {
          for (const part of message.content as readonly object[]) {
            expect(body).toContain(JSON.stringify(part));
          }
        }
        const reasoned = kept.flatMap((message) =>
          (message.content as readonly { type?: string }[]).filter((part) =>
            /thinking|reasoning/.test(String(part.type)),
          ),
        );
        // Where the turns after it are kept as they were, one of them was thought about.
        expect(reasoned.length).toBeGreaterThanOrEqual(provider.compacts === 'older' ? 1 : 0);
        expect(answer.stopReason).toBe('stop');
        expect(provider.read(answer.message).text).toMatch(/4411/);
      },
    );

    it.runIf(searches)(
      'counts the searches its own web search made, and what they cost',
      async () => {
        const { recorded, sent, answer } = await run('web-search');
        expect(sent).toEqual([recorded.request]);
        expect(answer).toEqual((recorded.expected as { answer: ModelAnswer }).answer);
        expect(answer.stopReason).toBe('stop');
        expect(answer.toolCalls).toEqual([]);
        expect(provider.read(answer.message).text).not.toBe('');
        expect(answer.usage?.webSearches).toBe(1);
        // A search is charged for apart from the tokens: the cost is more than theirs alone.
        const { cost } = answer.usage ?? {};
        const tokens =
          (cost?.input ?? 0) +
          (cost?.output ?? 0) +
          (cost?.cacheRead ?? 0) +
          (cost?.cacheWrite ?? 0);
        expect((cost?.total ?? 0) - tokens).toBeCloseTo(0.01, 6);
      },
    );

    it.runIf(searches)(
      'sends an answer that searched back as it was, and the provider takes it',
      async () => {
        const { answer: searched } = await run('web-search');
        const { recorded, sent, answer } = await run('web-search-next');
        expect(sent).toEqual([recorded.request]);
        // Every item the provider wrote for its search is in what it is sent next, whole.
        const body = JSON.stringify(sent[0]?.body);
        for (const part of searched.message.content as readonly object[]) {
          expect(body).toContain(JSON.stringify(part));
        }
        expect(answer.stopReason).toBe('stop');
        // It was told not to search again, and did not.
        expect(answer.usage?.webSearches).toBeUndefined();
      },
    );

    it.each(['text', 'tool-call', 'tool-result'])(
      '%s: sends what was sent, and reads what was read',
      async (scenario) => {
        const { recorded, sent, answer } = await run(scenario);
        expect(sent).toEqual([recorded.request]);
        expect(answer).toEqual((recorded.expected as { answer: ModelAnswer }).answer);
      },
    );

    it('answers in text', async () => {
      const { answer } = await run('text');
      expect(provider.read(answer.message)).toMatchObject({ text: 'pong', toolCalls: [] });
      expect(answer.stopReason).toBe('stop');
      expect(answer.message).toMatchObject({ role: 'assistant', provider: id });
    });

    it('says what a call used, and what that costs', async () => {
      const { answer } = await run('text');
      expect(answer.usage?.totalInput).toBeGreaterThan(0);
      expect(answer.usage?.output).toBeGreaterThan(0);
      expect(answer.usage?.cost).toMatchObject({ source: 'estimated' });
      expect(answer.usage?.cost?.total).toBeGreaterThan(0);
    });

    it('reads the call of a tool out of its answer', async () => {
      const { answer } = await run('tool-call');
      expect(answer.stopReason).toBe('tool_use');
      expect(answer.toolCalls).toHaveLength(1);
      expect(answer.toolCalls[0]).toMatchObject({ name: 'lookup_order', arguments: { id: 4411 } });
      expect(answer.toolCalls[0]?.id).not.toBe('');
      expect(provider.read(answer.message).toolCalls).toEqual(answer.toolCalls);
    });

    it('sends its own answer back as it was, with the tool’s result', async () => {
      const { answer: called } = await run('tool-call');
      const { sent, answer } = await run('tool-result');
      // Every item the provider wrote is in what it is sent next, whole.
      const body = JSON.stringify(sent[0]?.body);
      const written = called.message.content
        .flatMap((item) => Object.values(item))
        .filter((value): value is string => typeof value === 'string' && value.length > 8);
      expect(written.length).toBeGreaterThan(0);
      for (const value of written) expect(body).toContain(JSON.stringify(value).slice(1, -1));
      expect(body).toContain('Order 4411 was refunded twice, one second apart.');
      expect(answer.stopReason).toBe('stop');
      expect(provider.read(answer.message).text).toMatch(/refunded/);
    });

    it('fails as a matter of the credential when the key is refused, and is not tried again', async () => {
      const recorded = fixture(id, 'bad-key');
      const { fetch } = answering(recorded.response);
      const failed = provider
        .runner({ credential: credentialFor(id), fetch })
        .run(recorded.step, signal());
      await expect(failed).rejects.toBeInstanceOf(ModelFailure);
      await expect(failed).rejects.toMatchObject({
        kind: 'auth',
        retryable: false,
        status: 401,
        provider: id,
      });
    });

    it('fails as not found for a model there is none of', async () => {
      const recorded = fixture(id, 'unknown-model');
      const { fetch } = answering(recorded.response);
      const failed = provider
        .runner({ credential: credentialFor(id), fetch })
        .run(recorded.step, signal());
      // A plan says so with 400, and what it says of the model.
      await expect(failed).rejects.toMatchObject({
        kind: 'not_found',
        retryable: false,
        status: id === 'chatgpt' ? 400 : 404,
      });
    });
  },
);
