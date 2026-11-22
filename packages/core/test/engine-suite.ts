// What the engine does, on any store. It is run on the store in memory here, and on the store
// on SQLite in its own package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelFailure } from '@acentric/ai';
import type { ModelAnswer } from '@acentric/ai';
import { calls, says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';

import {
  ActorArchived,
  ActorNotFound,
  CodeUnavailable,
  Conflict,
  InvalidInput,
  Unavailable,
  UnknownInput,
} from '../src/errors.ts';
import type { Store } from '../src/store.ts';
import { Lost } from '../src/testing.ts';
import { HANDLER, LOOKUP, deferred, eventually, over, world } from './world.ts';
import type { World } from './world.ts';

const lookup = calls({ id: 'c1', name: 'lookup_order', arguments: { id: 4411 } });
const never = <T>() => new Promise<T>(() => {});
const overloaded = () => {
  throw new ModelFailure('The provider is overloaded', 'overloaded');
};

export function engineSuite(name: string, open: () => Promise<Store>): void {
  describe(`the engine, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    const fresh = (retrySafe = false) => {
      w = world({ store, retrySafe });
      return w;
    };

    beforeEach(async () => {
      store = await open();
      fresh();
    });
    afterEach(async () => {
      await store.close();
    });

    describe('one turn', () => {
      it('takes a message, calls the model, runs its tool, and ends with its answer', async () => {
        const one = w.engine([lookup, says('It was refunded twice.')]);
        const actor = await one.createActor();
        const sent = await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);

        expect(sent.status).toBe('accepted');
        const conversation = await store.conversation(actor.id);
        expect(conversation.map((entry) => [entry.seq, entry.message.role])).toEqual([
          [1, 'user'],
          [2, 'assistant'],
          [3, 'tool_result'],
          [4, 'assistant'],
        ]);
        expect(conversation[0]?.input).toEqual({ id: sent.input, type: 'message' });
        expect(conversation[2]?.message).toMatchObject({
          toolCallId: 'c1',
          isError: false,
          content: [{ type: 'text', text: 'Order 4411 was refunded twice.' }],
        });
        const record = await store.loadActor(actor.id);
        expect(record?.turn).toEqual({ phase: 'idle' });
        expect(record?.actor).toMatchObject({
          status: 'idle',
          pendingInputs: 0,
          lastTurn: { end: 'ok' },
        });
        // The mail taken, the first answer, the tool's result with the return to the model, the last answer.
        expect(record?.epoch).toBe(4);
        expect(one.failures).toEqual([]);
      });

      it('calls the model with the definition and the conversation so far', async () => {
        const one = w.engine([lookup, says('It was refunded twice.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);

        expect(one.steps).toHaveLength(2);
        expect(one.steps[0]).toMatchObject({
          model: 'fake-1',
          instructions: 'You answer questions about orders.',
          tools: [{ type: 'function', name: 'lookup_order' }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Why two refunds?' }] }],
        });
        expect(one.steps[1]?.messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'tool_result',
        ]);
        expect(one.executor.made).toEqual([
          { path: HANDLER, argument: { text: 'Why two refunds?' } },
          { path: LOOKUP, argument: { id: 4411 } },
        ]);
      });

      it('tells whoever follows it each message once it is stored, and where it stands', async () => {
        const one = w.engine([lookup, says('It was refunded twice.')]);
        const actor = await one.createActor();
        one.follow(actor.id);
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);

        expect(one.events.map((event) => event.type)).toEqual([
          'status',
          'message',
          'status',
          'message',
          'message',
          'message',
          'status',
        ]);
        expect(one.events[0]).toMatchObject({ status: 'idle', pendingInputs: 1 });
        expect(one.events[2]).toMatchObject({ status: 'working', pendingInputs: 0 });
        // Told the actor is idle, a follower has every message of the turn that ended.
        expect(one.events.at(-1)).toMatchObject({ status: 'idle', lastTurn: { end: 'ok' } });
      });

      it('loads the agent’s code once, and reads the conversation from the store once', async () => {
        let read = 0;
        const counted = over(store, {
          conversation: (actor, part) => {
            read += 1;
            return store.conversation(actor, part);
          },
        });
        w = world({ store: counted });
        const one = w.engine([lookup, says('Twice.'), says('Yes.'), says('No.')]);
        const actor = await one.createActor();
        for (const text of ['Why two refunds?', 'Was it in the EU?', 'Was it refunded again?']) {
          await one.say(actor.id, text);
          await one.it.settled(actor.id);
        }

        expect(await w.roles(actor.id)).toHaveLength(8);
        expect(one.steps.at(-1)?.messages).toHaveLength(7);
        expect(one.executor.loads).toBe(1);
        expect(read).toBe(1 + 1);
      });
    });

    describe('the model', () => {
      it('is called with what names the conversation, the same at every call', async () => {
        const one = w.engine([lookup, says('It was refunded twice.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);
        expect(one.steps.map((step) => step.session)).toEqual([actor.id, actor.id]);
      });

      it('has its tool’s result sent back with what its provider wants said again', async () => {
        const called = calls({
          id: 'c1',
          name: 'lookup_order',
          arguments: { id: 4411 },
          resultOptions: { caller: { type: 'direct' } },
        });
        const one = w.engine([called, says('It was refunded twice.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);
        expect((await store.conversation(actor.id))[2]?.message).toMatchObject({
          role: 'tool_result',
          providerOptions: { caller: { type: 'direct' } },
        });
      });

      it('is called again when its provider paused in the middle of its own work', async () => {
        const paused: ModelAnswer = { ...says('Searching.'), stopReason: 'pause_turn' };
        const one = w.engine([paused, says('Found it.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Find it.');
        await one.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'assistant']);
        expect(one.steps[1]?.messages).toHaveLength(2);
      });

      it('is that of the actor’s agent, when the engine is given a source of them', async () => {
        const asked: string[] = [];
        const one = w.engine([], {
          options: {
            runner: (actor, definition) => ({
              run: async () => {
                asked.push(`${definition.provider} for ${actor.id}`);
                return says('Hello.');
              },
            }),
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        expect(asked).toEqual([`fake for ${actor.id}`]);
      });

      it('that cannot be had fails the turn, with what is missing', async () => {
        const one = w.engine([], {
          options: {
            runner: () => {
              throw new Error('There is no account for Fake: its calls cannot be made');
            },
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        expect((await store.loadActor(actor.id))?.actor.lastTurn).toEqual({
          end: 'failed',
          at: expect.any(Number) as number,
          reason: 'There is no account for Fake: its calls cannot be made',
        });
        expect(one.failures).toEqual([]);
      });
    });

    describe('a call of the model that fails', () => {
      it('in a way that may pass is made again, after a wait that grows', async () => {
        const one = w.engine([overloaded, overloaded, says('Hello.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);

        expect(w.waits).toEqual([1000, 2000]);
        expect(one.steps).toHaveLength(3);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
        expect((await store.loadActor(actor.id))?.actor.lastTurn?.end).toBe('ok');
      });

      it('too many times ends the turn as failed, with why', async () => {
        const one = w.engine([overloaded, overloaded, overloaded, overloaded]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);

        expect(one.steps).toHaveLength(4);
        expect((await store.loadActor(actor.id))?.actor).toMatchObject({
          status: 'idle',
          lastTurn: { end: 'failed', reason: 'The provider is overloaded' },
        });
      });

      it('in a way that will not pass ends the turn at once', async () => {
        const one = w.engine([
          () => {
            throw new ModelFailure('The request is too large', 'invalid_request');
          },
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);

        expect(w.waits).toEqual([]);
        expect((await store.loadActor(actor.id))?.actor.lastTurn).toMatchObject({ end: 'failed' });
        expect(await w.roles(actor.id)).toEqual(['user']);
      });

      it('is tried again, with nothing new, when a person asks', async () => {
        const one = w.engine([
          () => {
            throw new Error('boom');
          },
          says('Hello.'),
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);

        await one.it.retry(actor.id);
        await one.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);

        // There is nothing to try again once it has gone well.
        await expect(one.it.retry(actor.id)).rejects.toBeInstanceOf(Conflict);
      });
    });

    describe('what was used', () => {
      const used = { totalInput: 40, input: 30, cacheRead: 10, output: 5 };
      const cost = { total: 0.002, source: 'estimated' } as const;
      const account = makeId('account', { now: 1, random: new Uint8Array(10).fill(3) });

      it('is written down for every call of the model, answered or failed', async () => {
        const one = w.engine([
          overloaded,
          { ...lookup, usage: used },
          { ...says('It was refunded twice.'), usage: { ...used, cost } },
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'What happened to order 4411?');
        await one.it.settled(actor.id);

        const report = await one.it.usage({}, 'actor');
        expect(report.totals).toMatchObject({
          calls: 3,
          failed: 1,
          totalInput: 80,
          input: 60,
          cacheRead: 20,
          output: 10,
          cost: 0.002,
          estimatedCost: 0.002,
          // The call that was answered with no cost. One that failed is not unpriced.
          unpriced: 1,
        });
        expect(report.groups?.map((group) => [group.key, group.totals.calls])).toEqual([
          [actor.id, 3],
        ]);
        expect((await one.it.usage({}, 'model')).groups?.[0]?.key).toBe('fake-1');
        expect((await one.it.usage({}, 'provider')).groups?.[0]?.key).toBe('fake');
        // The engine was given a runner, and no account.
        expect((await one.it.usage({}, 'account')).groups?.[0]?.key).toBe('');
      });

      it('is of the model account the call was made with', async () => {
        const one = w.engine([], {
          options: {
            runner: () => ({
              account,
              runner: { run: async () => ({ ...says('Hi.'), usage: used }) },
            }),
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        expect((await one.it.usage({ account })).totals).toMatchObject({ calls: 1, output: 5 });
        expect((await one.it.usage({}, 'account')).groups?.[0]?.key).toBe(account);
      });

      it('has nothing of a turn whose model could not be had: no provider was asked', async () => {
        const one = w.engine([], {
          options: {
            runner: () => {
              throw new Error('There is no model account for Fake');
            },
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        expect((await one.it.usage()).totals.calls).toBe(0);
      });

      it('stays when the agent it was used by is deleted, with its actors', async () => {
        const one = w.engine([{ ...says('Hello.'), usage: used }]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        await one.it.deleteAgent(actor.agent);
        await expect(one.it.getActor(actor.id)).rejects.toBeInstanceOf(ActorNotFound);
        expect((await one.it.usage({ actor: actor.id })).totals).toMatchObject({
          calls: 1,
          totalInput: 40,
        });
        expect((await one.it.usage({ agent: actor.agent })).totals.calls).toBe(1);
      });
    });

    describe('mail', () => {
      it('that comes while a tool runs joins the turn when it goes back to the model', async () => {
        const gate = deferred<string>();
        const one = w.engine([lookup, says('Both answered.')], { lookup: () => gate.promise });
        const actor = await one.createActor();

        await one.say(actor.id, 'Why two refunds?');
        await eventually(() => one.executor.made.some((call) => call.path === LOOKUP));
        await one.say(actor.id, 'And was it in the EU?');
        gate.resolve('Order 4411 was refunded twice.');
        await one.it.settled(actor.id);

        expect(await w.roles(actor.id)).toEqual([
          'user',
          'assistant',
          'tool_result',
          'user',
          'assistant',
        ]);
        // One turn: the second message started no turn of its own.
        expect(one.steps).toHaveLength(2);
      });

      it('that comes during the last call of the model starts another turn', async () => {
        const one = w.engine([
          async () => {
            await one.say(actor.id, 'One more thing.');
            return says('First answer.');
          },
          says('Second answer.'),
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await one.it.settled(actor.id);

        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect((await store.loadActor(actor.id))?.actor.pendingInputs).toBe(0);
      });

      it('that comes just as the actor goes idle is not left waiting', async () => {
        const one = w.engine([says('First answer.'), says('Second answer.')]);
        const actor = await one.createActor();
        let again: Promise<unknown> | undefined;
        // Sent from inside the telling that the turn has ended: as late as mail can come.
        one.it.bus.subscribe(actor.id, (event) => {
          if (event.type === 'status' && event.lastTurn !== null && again === undefined) {
            again = one.say(actor.id, 'One more thing.');
          }
        });
        await one.say(actor.id, 'Hello.');
        await eventually(async () => (await w.roles(actor.id)).length === 4);
        await again;
        await one.it.settled(actor.id);

        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
      });

      it('sent twice with one external ID is stored once, and the agent’s code runs once', async () => {
        const one = w.engine([says('Hello.')]);
        const actor = await one.createActor();
        const first = await one.say(actor.id, 'Hello.', 'update-9');
        const second = await one.say(actor.id, 'Hello.', 'update-9');
        await one.it.settled(actor.id);

        expect([first.status, second.status]).toEqual(['accepted', 'duplicate']);
        expect(second.input).toBe(first.input);
        expect(one.executor.made.filter((call) => call.path === HANDLER)).toHaveLength(1);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });

      it('is refused when it is of no type the agent has, or the agent’s code refuses it', async () => {
        const one = w.engine([], {
          handler: () => {
            throw new Error('The text is empty');
          },
        });
        const actor = await one.createActor();
        await expect(one.it.send(actor.id, { type: 'voice' })).rejects.toBeInstanceOf(UnknownInput);
        await expect(one.say(actor.id, '')).rejects.toBeInstanceOf(InvalidInput);
        const nobody = makeId('actor', { now: 1, random: new Uint8Array(10) });
        await expect(one.say(nobody, 'Hello.')).rejects.toBeInstanceOf(ActorNotFound);
        expect(await w.roles(actor.id)).toEqual([]);
      });
    });

    describe('an interrupt', () => {
      it('ends a call of the model, and the next message starts a new turn', async () => {
        const one = w.engine([() => never<ModelAnswer>(), says('Hello again.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await eventually(() => one.steps.length === 1);

        const after = await one.it.interrupt(actor.id);
        expect(after).toMatchObject({ status: 'idle', lastTurn: { end: 'interrupted' } });
        expect(await w.roles(actor.id)).toEqual(['user']);

        await one.say(actor.id, 'Are you there?');
        await one.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'user', 'assistant']);
      });

      it('ends tool calls, each with an answer that says it was stopped', async () => {
        let aborted = false;
        const one = w.engine([lookup], {
          lookup: (_, __, signal) =>
            new Promise<string>(() => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
            }),
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await eventually(() => one.executor.made.some((call) => call.path === LOOKUP));

        await one.it.interrupt(actor.id);
        const conversation = await store.conversation(actor.id);
        expect(conversation.map((entry) => entry.message.role)).toEqual([
          'user',
          'assistant',
          'tool_result',
        ]);
        expect(conversation[2]?.message).toMatchObject({ toolCallId: 'c1', isError: true });
        // The tool was told to stop.
        expect(aborted).toBe(true);
      });

      it('of an actor that is in no turn does nothing', async () => {
        const one = w.engine([]);
        const actor = await one.createActor();
        expect(await one.it.interrupt(actor.id)).toMatchObject({ status: 'idle', lastTurn: null });
      });
    });

    describe('archiving', () => {
      it('puts an actor away: it takes nothing until it is brought back', async () => {
        const one = w.engine([says('Hello.')]);
        const actor = await one.createActor();

        expect(await one.it.archive(actor.id)).toMatchObject({ status: 'archived' });
        await expect(one.say(actor.id, 'Hello?')).rejects.toBeInstanceOf(ActorArchived);
        expect((await store.loadActor(actor.id))?.actor.archivedAt).not.toBeNull();

        expect(await one.it.unarchive(actor.id)).toMatchObject({
          status: 'idle',
          archivedAt: null,
        });
        await one.say(actor.id, 'Hello?');
        await one.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });

      it('ends the turn an actor is in first', async () => {
        const one = w.engine([() => never<ModelAnswer>()]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await eventually(() => one.steps.length === 1);

        expect(await one.it.archive(actor.id)).toMatchObject({
          status: 'archived',
          lastTurn: { end: 'interrupted' },
        });
      });
    });

    describe('the agent’s code', () => {
      const dies = () => {
        throw new Lost('workerd exited with SIGKILL');
      };

      it('lost with a tool call in it is called again, once, when the tool is safe to call again', async () => {
        fresh(true);
        let made = 0;
        const one = w.engine([lookup, says('Twice.')], {
          lookup: () => {
            made += 1;
            return made === 1 ? dies() : 'Refunded twice.';
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);

        expect(made).toBe(2);
        expect((await store.conversation(actor.id))[2]?.message).toMatchObject({
          role: 'tool_result',
          isError: false,
          content: [{ type: 'text', text: 'Refunded twice.' }],
        });
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
      });

      // A tool lost for good: what the model is told, and how often the tool was called.
      const lostForGood = async (retrySafe: boolean) => {
        fresh(retrySafe);
        let made = 0;
        const one = w.engine([lookup, says('I could not tell.')], {
          lookup: () => {
            made += 1;
            return dies();
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);
        expect((await store.conversation(actor.id))[2]?.message).toMatchObject({
          role: 'tool_result',
          isError: true,
          content: [
            {
              type: 'text',
              text: 'The call of lookup_order was lost: workerd exited with SIGKILL. It may or may not have run.',
            },
          ],
        });
        // The turn goes on: the model reads what happened, and answers.
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
        return made;
      };

      it('lost with a tool that is not safe to call again is told to the model, and not called again', async () => {
        expect(await lostForGood(false)).toBe(1);
      });

      it('lost twice with a tool that is safe to call again is told to the model the same', async () => {
        expect(await lostForGood(true)).toBe(2);
      });

      it('lost with an input in it refuses the input as something to send again, and stores nothing', async () => {
        const one = w.engine([], { handler: dies });
        const actor = await one.createActor();
        const sent = one.say(actor.id, 'Hello?');
        await expect(sent).rejects.toBeInstanceOf(CodeUnavailable);
        await expect(sent).rejects.toMatchObject({ code: 'unavailable' });
        expect(await store.pendingInputs(actor.id)).toEqual([]);
      });

      it('that is no tool is given up when it takes too long, and a tool is not', async () => {
        const slow = () => new Promise<string>((resolve) => setTimeout(resolve, 150, 'late'));
        const one = w.engine([lookup, says('Twice.')], {
          handler: (payload) =>
            (payload as { text: string }).text === 'slow' ? slow() : 'Why two refunds?',
          lookup: slow,
          options: { codeTimeoutMs: 40 },
        });
        const actor = await one.createActor();
        const refused = one.say(actor.id, 'slow');
        await expect(refused).rejects.toBeInstanceOf(InvalidInput);
        await expect(refused).rejects.toThrow(
          'inputs.message.handler did not return within 0.04 s, and was given up',
        );
        expect(await store.pendingInputs(actor.id)).toEqual([]);

        // The tool takes longer than that, and is waited for.
        await one.say(actor.id, 'quick');
        await one.it.settled(actor.id);
        expect((await store.conversation(actor.id))[2]?.message).toMatchObject({
          role: 'tool_result',
          content: [{ type: 'text', text: 'late' }],
        });
      });
    });

    describe('a turn the model declines', () => {
      it('is refused, and nothing of it is sent to the model again', async () => {
        const declined: ModelAnswer = {
          ...says('I cannot help with that.'),
          stopReason: 'refusal',
        };
        const one = w.engine([declined, says('Order 4411 was refunded twice.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Something it will decline.');
        await one.it.settled(actor.id);
        expect((await store.loadActor(actor.id))?.actor.lastTurn).toMatchObject({ end: 'refused' });

        await one.say(actor.id, 'Why two refunds?');
        await one.it.settled(actor.id);

        expect(one.steps[1]?.messages).toEqual([
          { role: 'user', content: [{ type: 'text', text: 'Why two refunds?' }] },
        ]);
        // It is all still there to be read.
        expect((await store.conversation(actor.id)).map((entry) => entry.leftOut ?? false)).toEqual(
          [true, true, false, false],
        );
      });
    });

    describe('many actors', () => {
      it('are in a turn at most so many at once, and all get theirs', async () => {
        let inFlight = 0;
        let most = 0;
        const gates = Array.from({ length: 6 }, () => deferred<ModelAnswer>());
        let asked = 0;
        const one = w.engine(
          {
            async run() {
              const gate = gates[asked++];
              inFlight += 1;
              most = Math.max(most, inFlight);
              const answer = await (gate as (typeof gates)[number]).promise;
              inFlight -= 1;
              return answer;
            },
          },
          { options: { maxConcurrentTurns: 2 } },
        );
        const actors = await Promise.all(gates.map(() => one.createActor()));
        await Promise.all(actors.map((actor) => one.say(actor.id, 'Hello.')));

        for (const [index, gate] of gates.entries()) {
          // An answer is held back until the next actor's call is under way as well, where
          // there is a next: otherwise a quick answer could come before two were ever at once.
          await eventually(() => asked >= Math.min(index + 2, gates.length));
          expect(inFlight).toBeLessThanOrEqual(2);
          gate.resolve(says('Hello.'));
        }
        await one.it.settled();

        expect(most).toBe(2);
        const roles = await Promise.all(actors.map((actor) => w.roles(actor.id)));
        expect(roles).toEqual(actors.map(() => ['user', 'assistant']));
      });

      it('take an input once, though their driver was given up while the agent’s code read it', async () => {
        const slow = deferred<string>();
        const one = w.engine([says('Hello B.'), says('Hello A.')], {
          handler: (payload) => {
            const { text } = payload as { text: string };
            return text === 'slow' ? slow.promise : text;
          },
          options: { maxHotActors: 1 },
        });
        const a = await one.createActor();
        const b = await one.createActor();

        const sending = one.say(a.id, 'slow');
        await eventually(() => one.executor.made.length === 1);
        // While the agent's code reads what A was sent, B takes a turn, and A's driver, which
        // has nothing to do yet, is the one given up.
        await one.say(b.id, 'Hello.');
        await one.it.settled(b.id);
        slow.resolve('Hello.');
        await sending;
        await one.it.settled(a.id);

        expect(await w.roles(a.id)).toEqual(['user', 'assistant']);
        expect((await store.loadActor(a.id))?.actor.pendingInputs).toBe(0);
      });

      it('keep a driver only while they have something to do, past a number', async () => {
        const one = w.engine(
          Array.from({ length: 5 }, () => says('Hello.')),
          { options: { maxHotActors: 2 } },
        );
        const actors = [];
        for (let index = 0; index < 4; index += 1) {
          const actor = await one.createActor();
          await one.say(actor.id, 'Hello.');
          await one.it.settled(actor.id);
          actors.push(actor);
        }
        expect(one.it.hot).toBeLessThanOrEqual(2);

        // One whose driver was given up is read from the store again, and goes on as it was.
        const first = (actors[0] as (typeof actors)[number]).id;
        await one.say(first, 'Hello again.');
        await one.it.settled(first);
        expect(await w.roles(first)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(one.steps.at(-1)?.messages).toHaveLength(3);
      });
    });

    describe('a restart', () => {
      it('in a call of the model: the next process makes the call again, counted, and the first is shut out', async () => {
        const hung = deferred<ModelAnswer>();
        const first = w.engine([() => hung.promise]);
        const actor = await first.createActor();
        await first.say(actor.id, 'Hello.');
        await eventually(() => first.steps.length === 1);

        // The first process is gone, as far as anything can tell. A second starts on the store.
        const second = w.engine([
          async () => {
            const turn = (await store.loadActor(actor.id))?.turn;
            expect(turn).toMatchObject({ phase: 'model', cutOffs: 1 });
            return says('Hello.');
          },
        ]);
        expect(await second.it.recover()).toBe(1);
        await second.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
        expect((await store.loadActor(actor.id))?.actor.lastTurn?.end).toBe('ok');

        // The first process was not gone after all, and its call comes back. It may store nothing.
        hung.resolve(says('Late.'));
        await first.it.settled(actor.id);
        expect(first.failures).toHaveLength(1);
        expect(first.failures[0]).toMatchObject({ name: 'StaleEpoch' });
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });

      it('in a tool that is not safe to call again: the model is told it may or may not have run', async () => {
        fresh(false);
        const first = w.engine([lookup], { lookup: () => never<string>() });
        const actor = await first.createActor();
        await first.say(actor.id, 'Why two refunds?');
        await eventually(() => first.executor.made.some((call) => call.path === LOOKUP));

        const second = w.engine([says('I could not confirm it.')]);
        await second.it.recover();
        await second.it.settled(actor.id);

        expect(second.executor.made).toEqual([]);
        const conversation = await store.conversation(actor.id);
        expect(conversation.map((entry) => entry.message.role)).toEqual([
          'user',
          'assistant',
          'tool_result',
          'assistant',
        ]);
        expect(conversation[2]?.message).toMatchObject({
          isError: true,
          content: [
            { type: 'text', text: expect.stringContaining('may or may not have run') as string },
          ],
        });
      });

      it('in a tool that is safe to call again: it is called again', async () => {
        fresh(true);
        const first = w.engine([lookup], { lookup: () => never<string>() });
        const actor = await first.createActor();
        await first.say(actor.id, 'Why two refunds?');
        await eventually(() => first.executor.made.some((call) => call.path === LOOKUP));

        const second = w.engine([says('It was refunded twice.')]);
        await second.it.recover();
        await second.it.settled(actor.id);

        expect(second.executor.made).toEqual([{ path: LOOKUP, argument: { id: 4411 } }]);
        expect((await store.conversation(actor.id))[2]?.message).toMatchObject({ isError: false });
      });

      it('during the wait for a later try: the wait goes on from where it was, and nothing is counted', async () => {
        const first = w.engine([overloaded], { options: { timer: () => never<void>() } });
        const actor = await first.createActor();
        await first.say(actor.id, 'Hello?');
        await eventually(
          async () =>
            (await store.loadActor(actor.id))?.turn.phase === 'model' && first.steps.length === 1,
        );
        await eventually(async () => {
          const turn = (await store.loadActor(actor.id))?.turn;
          return turn?.phase === 'model' && turn.retryAt !== null;
        });

        w.advance(400);
        const second = w.engine([says('Hello.')]);
        await second.it.recover();
        await second.it.settled(actor.id);

        expect(w.waits).toEqual([600]);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });

      it('with mail that no turn had taken: a turn takes it', async () => {
        const actor = await w.engine([]).createActor();
        await store.addInput({
          id: makeId('input', { now: 5, random: new Uint8Array(10) }),
          actor: actor.id,
          type: 'message',
          externalId: null,
          message: { role: 'user', content: [{ type: 'text', text: 'Hello.' }] },
          receivedAt: 5,
          deliveredAt: null,
        });

        const second = w.engine([says('Hello.')]);
        expect(await second.it.recover()).toBe(1);
        await second.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });
    });

    describe('shutting down', () => {
      it('lets a call that is under way end, and stores its answer', async () => {
        const answer = deferred<ModelAnswer>();
        const one = w.engine([() => answer.promise], { options: { timer: () => never<void>() } });
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await eventually(() => one.steps.length === 1);

        const closed = one.it.close();
        await expect(one.say(actor.id, 'Too late.')).rejects.toBeInstanceOf(Unavailable);
        answer.resolve(says('Hello.'));
        await closed;

        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
        expect((await store.loadActor(actor.id))?.turn).toEqual({ phase: 'idle' });
      });

      it('gives up a call that does not end in time: it stays owed, for the next process', async () => {
        const one = w.engine([() => never<ModelAnswer>()]);
        const actor = await one.createActor();
        await one.say(actor.id, 'Hello.');
        await eventually(() => one.steps.length === 1);

        // The time it is given is over at once: the world's timer does not wait.
        await one.it.close({ graceMs: 50 });
        expect((await store.loadActor(actor.id))?.turn).toMatchObject({ phase: 'model' });
        expect(await store.unfinished()).toEqual([actor.id]);

        const next = w.engine([says('Hello.')]);
        await next.it.recover();
        await next.it.settled(actor.id);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant']);
      });
    });
  });
}
