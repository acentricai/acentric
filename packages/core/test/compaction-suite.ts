// Compaction, through the whole engine, on any store: a conversation that has grown past its
// size is compacted before its model is called again, by its provider where the provider has
// a way, and by a summary its model writes where it has none.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelFailure, Providers } from '@acentric/ai';
import type { ModelStep } from '@acentric/ai';
import { calls, compacted, fakeProvider, reasoned, says, used } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import type { ActorId, ConversationEntry, Message } from '@acentric/protocol';

import { ActorBusy, CompactionFailed } from '../src/errors.ts';
import type { Store } from '../src/store.ts';
import { MANIFEST, world } from './world.ts';
import type { World } from './world.ts';

/** What a message says, as text. */
function textOf(message: Message | undefined): string {
  const { content } = (message ?? {}) as {
    content?: readonly {
      readonly type: string;
      readonly text?: string;
      readonly content?: string;
    }[];
  };
  return (content ?? []).map((part) => part.text ?? part.content ?? `[${part.type}]`).join('');
}

/** The agent of the tests as code that says when its conversation is compacted: early, and with little kept. */
const SMALL = 'orders@small';
const VERSIONS = {
  [SMALL]: {
    definition: {
      features: ['compaction-settings'],
      // 100 tokens is as large as it grows, and the newest message alone is kept as it is.
      compactionSettings: {
        'fake-1': { threshold: 100, reserve: 1 },
        // More is kept as it is: the last answer, and what the user said.
        'fake-bound': { threshold: 100, reserve: 20 },
        'fake-eyes': { threshold: 100, reserve: 50 },
      },
    },
  },
  // An agent whose actors can spawn others, and one of the others.
  'lead@small': {
    definition: {
      instructions: 'You lead.',
      features: ['subagents', 'compaction-settings'],
      subagents: [{ agent: 'helper', description: 'Does part of the work.', creates: false }],
      compactionSettings: { 'fake-1': { threshold: 100, reserve: 1 } },
    },
  },
  'helper@1': { definition: { instructions: 'You help.' } },
};

export function compactionSuite(name: string, open: () => Promise<Store>): void {
  describe(`compaction, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    let engines: ReturnType<World['engine']>[];

    /** An engine whose provider compacts as `compacts` says, and whose model does what `script` says, in order. */
    const setup = async (script: Scripted[], compacts?: 'older' | 'all', modelId?: string) => {
      const steps: ModelStep[] = [];
      const runner = {
        run: async (step: ModelStep, signal: AbortSignal) => {
          steps.push(structuredClone(step));
          const next = script.shift() ?? says('ok');
          return typeof next === 'function' ? next(step, signal) : next;
        },
      };
      const one = w.engine(runner, {
        versions: VERSIONS,
        options: {
          clock: Date.now,
          providers: new Providers([
            fakeProvider(runner, compacts === undefined ? {} : { compacts }),
          ]),
          rules: {
            retry: { maxAttempts: 2, initialDelayMs: 1, factor: 1, maxDelayMs: 1 },
            maxCutOffs: 5,
          },
        },
      });
      engines.push(one);
      await one.deploy(SMALL);
      const actor = await one.createActor(modelId === undefined ? {} : { modelId });
      const say = async (text: string) => {
        await one.say(actor.id, text);
        await one.it.settled(actor.id);
      };
      return { one, steps, script, actor, say };
    };

    const lines = async (actor: ActorId) =>
      (await store.conversation(actor)).map(
        (entry: ConversationEntry) => `${entry.message.role}: ${textOf(entry.message)}`,
      );
    /** What a step sent the model, a line each. */
    const sent = (step: ModelStep | undefined) =>
      (step?.messages ?? []).map((message) => `${message.role}: ${textOf(message)}`);

    beforeEach(async () => {
      store = await open();
      w = world({ store });
      engines = [];
    });
    afterEach(async () => {
      for (const one of engines) {
        await one.it.close({ graceMs: 50 });
        expect(one.failures).toEqual([]);
      }
      await store.close();
    });

    describe('a conversation that has grown past its size', () => {
      it('is compacted by its provider before the model is called again: the older part is summarized, and what is recent follows as it was', async () => {
        const { one, steps, actor, say } = await setup(
          [
            used(says('It was refunded twice.'), 80, 30),
            compacted('They asked why order 4411 had two refunds.'),
            used(says('Order 7 is fine.'), 40, 10),
          ],
          'older',
        );
        await say('Why two refunds?');
        // 110 tokens, of 100 at most: the next call of the model is not made as it is.
        await say('And order 7?');

        // The provider is asked with the actor's own call, on the older part alone.
        expect(steps).toHaveLength(3);
        expect(steps[1]).toMatchObject({
          compact: true,
          instructions: steps[0]?.instructions,
          tools: steps[0]?.tools,
        });
        expect(sent(steps[1])).toEqual([
          'user: Why two refunds?',
          'assistant: It was refunded twice.',
        ]);
        // Then the model is sent what stands for that part, and the rest as it was.
        expect(steps[2]?.compact).toBeUndefined();
        expect(sent(steps[2]).slice(0, 2)).toEqual([
          'assistant: They asked why order 4411 had two refunds.',
          'user: And order 7?',
        ]);
        expect(sent(steps[2])[2]).toContain('<compacted/>');

        // Nothing is taken out of the conversation: one line is added, where it was compacted.
        expect(await lines(actor.id)).toEqual([
          'user: Why two refunds?',
          'assistant: It was refunded twice.',
          'user: And order 7?',
          'system: <compacted/>',
          'assistant: Order 7 is fine.',
        ]);
        expect(await one.it.compactions(actor.id)).toEqual([
          {
            kind: 'older',
            atSeq: 4,
            keepFromSeq: 3,
            tokensBefore: 110,
            reason: 'threshold',
            createdAt: expect.any(Number) as number,
          },
        ]);
        // The call that compacted is written down as one, apart from the turn's.
        expect((await one.it.usage({ kind: 'compaction' })).totals.calls).toBe(1);
        expect((await one.it.usage({ kind: 'turn' })).totals.calls).toBe(2);
        expect((await one.it.usage({})).totals.calls).toBe(3);

        // It is small again: the next turn is sent as it stands, and nothing is compacted.
        await say('Thanks.');
        expect(steps).toHaveLength(4);
        expect(sent(steps[3])[0]).toBe('assistant: They asked why order 4411 had two refunds.');
        expect(await one.it.compactions(actor.id)).toHaveLength(1);
      });

      it('keeps the reasoning of the turns that follow what its provider wrote', async () => {
        const { steps, say } = await setup(
          [
            used(says('It was refunded twice.'), 10, 5),
            // Thought about, and large: the answer itself is recent when the next turn starts.
            used(reasoned('The refunds were a second apart.', says('A double charge.')), 80, 30),
            compacted('They asked about order 4411.'),
            says('Yes.'),
          ],
          'older',
          'fake-bound',
        );
        await say('Why two refunds?');
        await say('What caused it?');
        await say('Sure?');
        const after = steps[3]?.messages ?? [];
        // What follows the block is sent whole: the model's reasoning is in it.
        expect(JSON.stringify(after)).toContain('The refunds were a second apart.');
        expect(after[0]).toMatchObject({ content: [{ type: 'compaction' }] });
      });

      it('is compacted whole by a provider that compacts all it is sent: what the user said is kept before what stands for the rest', async () => {
        const { one, steps, actor, say } = await setup(
          [
            used(says('It was refunded twice.'), 80, 30),
            compacted('opaque'),
            says('Order 7 is fine.'),
          ],
          'all',
          'fake-eyes',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        // All of it is sent, to be compacted.
        expect(steps[1]?.compact).toBe(true);
        expect(sent(steps[1])).toEqual([
          'user: Why two refunds?',
          'assistant: It was refunded twice.',
          'user: And order 7?',
        ]);
        // What stands for it is all there is of it now, after the newest of what the user said.
        expect(sent(steps[2])).toEqual([
          'user: Why two refunds?',
          'user: And order 7?',
          'assistant: opaque',
          expect.stringContaining('<compacted/>') as string,
        ]);
        expect(await one.it.compactions(actor.id)).toMatchObject([
          { kind: 'all', atSeq: 4, keepFromSeq: 4, reason: 'threshold' },
        ]);
      });

      it('is summarized by its own model where its provider has no compaction: asked for text, with no tools', async () => {
        const { one, steps, actor, say } = await setup([
          used(says('It was refunded twice.'), 80, 30),
          says('## Goal\nFind out why order 4411 had two refunds.'),
          says('Order 7 is fine.'),
        ]);
        await say('Why two refunds?');
        await say('And order 7?');
        expect(steps[1]?.compact).toBeUndefined();
        expect(steps[1]?.tools).toEqual([]);
        expect(steps[1]?.instructions).toMatch(/^You are a context summarization assistant\./);
        const [asked] = sent(steps[1]);
        expect(asked).toMatch(
          /^user: <conversation>\n\[User\]: Why two refunds\?\n\n\[Assistant\]: It was refunded twice\.\n<\/conversation>\n\nThe messages above are a conversation to summarize\./,
        );
        expect(sent(steps[2]).slice(0, 2)).toEqual([
          'user: The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nFind out why order 4411 had two refunds.\n</summary>',
          'user: And order 7?',
        ]);
        expect(await one.it.compactions(actor.id)).toMatchObject([{ kind: 'summary' }]);
      });

      it('falls back to a written summary when its provider answers a compaction with nothing', async () => {
        const { one, steps, actor, say } = await setup(
          [
            used(says('It was refunded twice.'), 80, 30),
            // No block in it.
            says('I would rather not.'),
            says('## Goal\nRefunds.'),
            says('Order 7 is fine.'),
          ],
          'older',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        expect(steps.map((step) => step.compact === true)).toEqual([false, true, false, false]);
        expect(steps[2]?.tools).toEqual([]);
        expect(await one.it.compactions(actor.id)).toMatchObject([{ kind: 'summary' }]);
        expect((await one.it.usage({ kind: 'compaction' })).totals.calls).toBe(2);
      });

      it('fails the turn, with why, when it cannot be compacted, and is as it was', async () => {
        const down = () => {
          throw new ModelFailure('Fake refused the key', 'auth', { provider: 'fake' });
        };
        const { one, steps, actor, say } = await setup(
          [used(says('It was refunded twice.'), 80, 30), down],
          'older',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({
          end: 'failed',
          reason: 'The conversation could not be compacted: Fake refused the key',
        });
        expect(await one.it.compactions(actor.id)).toEqual([]);
        expect(steps).toHaveLength(2);
        // The call that failed is written down, as a compaction's.
        expect((await one.it.usage({ kind: 'compaction' })).totals).toMatchObject({
          calls: 1,
          failed: 1,
        });
      });
    });

    describe('a call its provider refuses as too large', () => {
      const tooLarge = () => {
        throw new ModelFailure('The conversation is too long for the model', 'context_overflow', {
          provider: 'fake',
        });
      };

      it('has the conversation compacted, and is made again as a first try', async () => {
        const { one, steps, actor, say } = await setup(
          [
            says('It was refunded twice.'),
            tooLarge,
            compacted('They asked about order 4411.'),
            says('Order 7 is fine.'),
          ],
          'older',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        expect(steps.map((step) => step.compact === true)).toEqual([false, false, true, false]);
        expect(await one.it.compactions(actor.id)).toMatchObject([{ reason: 'overflow' }]);
        expect((await lines(actor.id)).at(-1)).toBe('assistant: Order 7 is fine.');
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
        // The call that was refused is written down as a call that failed.
        expect((await one.it.usage({ kind: 'turn' })).totals).toMatchObject({
          calls: 3,
          failed: 1,
        });
      });

      it('fails the turn when it is refused again right after the conversation was compacted', async () => {
        const { one, actor, say } = await setup(
          [says('It was refunded twice.'), tooLarge, compacted('Short.'), tooLarge],
          'older',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({
          end: 'failed',
          reason: 'The conversation is too long for the model It had just been compacted.',
        });
      });

      it('fails the turn when there is nothing in the conversation to compact', async () => {
        // One message, and nothing before it.
        const { one, steps, actor, say } = await setup([tooLarge], 'older');
        await say('Why two refunds?');
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({
          end: 'failed',
          reason: 'The conversation is too long for the model There was nothing in it to compact.',
        });
        expect(steps).toHaveLength(1);
        expect(await one.it.compactions(actor.id)).toEqual([]);
      });
    });

    describe('compacting when asked', () => {
      it('compacts between turns whatever the size, and nothing when nothing is new', async () => {
        const { one, steps, actor, say } = await setup(
          [says('It was refunded twice.'), says('Order 7 is fine.'), compacted('Two orders.')],
          'older',
        );
        await say('Why two refunds?');
        await say('And order 7?');
        const done = await one.it.compact(actor.id);
        expect(done.compacted).toMatchObject({ kind: 'older', reason: 'asked', tokensBefore: 0 });
        expect(done.actor).toMatchObject({ id: actor.id, status: 'idle', lastTurn: { end: 'ok' } });
        expect(steps.at(-1)?.compact).toBe(true);
        expect((await lines(actor.id)).at(-1)).toBe('system: <compacted/>');
        // Nothing was said since, but the line it left.
        expect((await one.it.compact(actor.id)).compacted).toBeNull();
        expect(await one.it.compactions(actor.id)).toHaveLength(1);
      });

      it('is refused while the actor is in a turn, and says why when its model fails at it', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { one, actor, script } = await setup(
          [
            async () => {
              await held;
              return says('It was refunded twice.');
            },
            says('Order 7 is fine.'),
          ],
          'older',
        );
        await one.say(actor.id, 'Why two refunds?');
        await expect(one.it.compact(actor.id)).rejects.toBeInstanceOf(ActorBusy);
        release();
        await one.it.settled(actor.id);
        await one.say(actor.id, 'And order 7?');
        await one.it.settled(actor.id);

        script.push(() => {
          throw new ModelFailure('Fake refused the key', 'auth', { provider: 'fake' });
        });
        const failed = await one.it.compact(actor.id).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(CompactionFailed);
        expect(failed).toMatchObject({
          code: 'provider_failed',
          message: 'The conversation could not be compacted: Fake refused the key',
        });
        // It is as it was, and takes its next message.
        expect(await one.it.compactions(actor.id)).toEqual([]);
        script.push(says('Yes.'));
        await one.say(actor.id, 'Sure?');
        await one.it.settled(actor.id);
        expect((await lines(actor.id)).at(-1)).toBe('assistant: Yes.');
      });
    });

    describe('after a compaction', () => {
      it('the next engine sends what it left, and compacts nothing again', async () => {
        const first = await setup(
          [
            used(says('It was refunded twice.'), 80, 30),
            compacted('They asked about order 4411.'),
            used(says('Order 7 is fine.'), 40, 10),
          ],
          'older',
        );
        await first.say('Why two refunds?');
        await first.say('And order 7?');
        await first.one.it.close();

        const next = await setup([says('You are welcome.')], 'older');
        await next.one.say(first.actor.id, 'Thanks.');
        await next.one.it.settled(first.actor.id);
        expect(next.steps).toHaveLength(1);
        expect(sent(next.steps[0])[0]).toBe('assistant: They asked about order 4411.');
        expect(await next.one.it.compactions(first.actor.id)).toHaveLength(1);
      });

      it('the line it leaves tells the model what is still going on: the tasks that run, and the actors it spawned', async () => {
        const { one, steps } = await setup(
          [
            calls({
              id: 'c1',
              name: 'spawn_agent',
              arguments: { agent: 'helper', name: 'worker' },
            }),
            calls({
              id: 'c2',
              name: 'schedule',
              arguments: { note: 'Look at order 7 again.', in: 7200 },
            }),
            says('Set.'),
            compacted('A worker, and a note for later.'),
            says('Nothing yet.'),
          ],
          'older',
        );
        const lead = await one.it.deploy({ agent: 'lead', manifest: MANIFEST, code: 'lead@small' });
        await one.it.deploy({ agent: 'helper', manifest: MANIFEST, code: 'helper@1' });
        const { actor } = await one.it.createActor({ agent: lead.agent.id });
        await one.say(actor.id, 'Start.');
        await one.it.settled(actor.id);
        await one.it.compact(actor.id);
        expect((await lines(actor.id)).at(-1)).toMatch(
          /^system: <compacted>\nTasks running:\n- t1 schedule · fires in (2h00m|1h59m) · Look at order 7 again\.\nSubagents:\n- worker · idle\n<\/compacted>$/,
        );
        // The model reads it with its next call.
        await one.say(actor.id, 'Anything?');
        await one.it.settled(actor.id);
        expect(sent(steps.at(-1)).slice(0, 3)).toEqual([
          'assistant: A worker, and a note for later.',
          'assistant: Set.',
          expect.stringMatching(/^user: <system-notice>\n<compacted>\nTasks running:/) as string,
        ]);
      });

      it('a written summary has the reasoning of the turns before it left out, where its provider would refuse it', async () => {
        const { one, steps, actor, say } = await setup(
          [
            says('It was refunded twice.'),
            reasoned('The refunds were a second apart.', says('A double charge.')),
            // The summary, when it is asked for.
            says('## Goal\nRefunds.'),
            reasoned('It is certain.', says('Yes.')),
            says('You are welcome.'),
          ],
          undefined,
          'fake-bound',
        );
        await say('Why two refunds?');
        await say('What caused it?');
        // The last answer is kept as it was: it is recent.
        const { compacted: made } = await one.it.compact(actor.id);
        expect(made).toMatchObject({ kind: 'summary', keepFromSeq: 4 });
        await say('Sure?');
        const after = JSON.stringify(steps.at(-1)?.messages);
        expect(after).toContain('## Goal');
        // What it said is sent, and what it thought before the summary is not.
        expect(after).toContain('A double charge.');
        expect(after).not.toContain('The refunds were a second apart.');
        // What it thinks after the summary is sent as any reasoning is.
        await say('Thanks.');
        const later = JSON.stringify(steps.at(-1)?.messages);
        expect(later).toContain('It is certain.');
        expect(later).not.toContain('The refunds were a second apart.');
      });
    });
  });
}
