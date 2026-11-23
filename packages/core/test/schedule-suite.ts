// `schedule`, through the whole engine, on any store: a model sends its later self a note, and
// at that time the note arrives as a notice and sets the actor to work.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { calls, says } from '@acentric/ai/testing';
import type { ModelRunner, ModelStep } from '@acentric/ai';
import type { Scripted } from '@acentric/ai/testing';
import type { ActorId, ConversationEntry, Json } from '@acentric/protocol';

import type { Store } from '../src/store.ts';
import type { AgentFunction } from '../src/testing.ts';
import { world } from './world.ts';
import type { World } from './world.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a message says, as text. */
function textOf(entry: ConversationEntry | undefined): string {
  const { content } = (entry?.message ?? {}) as {
    content?: readonly { readonly type: string; readonly text?: string }[];
  };
  return (content ?? []).map((part) => part.text ?? `[${part.type}]`).join('');
}

/** The agent of the tests as code that has a schedule handler, and as newer code that has another. */
const TIMED = 'orders@timed';
const NEWER = 'orders@newer';
type Fired = { note: string; dueAt: number; firedAt: number };
const handler =
  (says_: string): AgentFunction =>
  async (fired, context) => {
    const { note, dueAt, firedAt } = fired as Fired;
    if (note === 'throw') throw new Error('no clock here');
    if (note === 'number') return 5;
    if (note === 'slow') await pause(300);
    return `${note}\n(${says_}: fired ${firedAt >= dueAt ? 'not early' : 'early'} for ${context.actor}; due ${new Date(dueAt).toISOString()})`;
  };
const VERSIONS = {
  [TIMED]: {
    definition: { features: ['schedule'] },
    functions: { 'schedule.handler': handler('one') },
  },
  [NEWER]: {
    definition: { features: ['schedule'] },
    functions: { 'schedule.handler': handler('newer') },
  },
};

export function scheduleSuite(name: string, open: () => Promise<Store>): void {
  describe(`schedule, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    let engines: ReturnType<World['engine']>[];

    /** An engine on the clock there is: a schedule fires by it. */
    const engine = (script: readonly Scripted[] | ModelRunner = []) => {
      const one = w.engine(script, {
        versions: VERSIONS,
        options: { clock: Date.now, taskTimes: { floorMs: 60 } },
      });
      engines.push(one);
      return one;
    };
    type One = ReturnType<typeof engine>;

    const conversation = (actor: ActorId) => store.conversation(actor);
    const results = async (actor: ActorId) =>
      (await conversation(actor))
        .filter((entry) => entry.message.role === 'tool_result')
        .map((entry) => ({
          text: textOf(entry),
          isError: (entry.message as { isError?: boolean }).isError === true,
        }));
    const notices = async (actor: ActorId) =>
      (await conversation(actor)).filter((entry) => entry.message.role === 'system');

    /** A world whose model does, in order, what each turn of a test says. */
    const scripted = () => {
      const script: Scripted[] = [];
      /** What the model was called with, in order. */
      const steps: ModelStep[] = [];
      let asked = 0;
      const one = engine({
        run: async (step, signal) => {
          steps.push(structuredClone(step));
          // With nothing said of what it does next, it says a word and ends its turn.
          const next = script.shift() ?? says('ok');
          return typeof next === 'function' ? next(step, signal) : next;
        },
      });
      /** Has the model call `schedule` once, and gives what the call was answered with. */
      const schedule = async (actor: ActorId, input: { [name: string]: Json }) => {
        asked += 1;
        script.push(calls({ id: `c${String(asked)}`, name: 'schedule', arguments: input }));
        await one.say(actor, 'go');
        await one.it.settled(actor);
        // Its turn is over: what is still to come is the firing.
        return (await results(actor)).at(-1) ?? { text: '', isError: false };
      };
      return { one, script, steps, schedule };
    };
    /** Until the actor has nothing running and nothing owed. */
    const quiet = async (one: One, actor: ActorId) => {
      await expect
        .poll(
          async () => {
            await one.it.settled(actor);
            const tasks = await one.it.tasks.list(actor);
            return tasks.every((task) => task.status !== 'running');
          },
          { timeout: 10_000, interval: 10 },
        )
        .toBe(true);
      await one.it.settled(actor);
    };

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

    describe('schedule', () => {
      it('is offered to every actor, and takes a note and a time, and nothing to wait with', async () => {
        const one = engine([says('Hello.')]);
        const actor = await one.createActor();
        await one.say(actor.id, 'hello');
        await one.it.settled(actor.id);
        const tools = one.steps[0]?.tools ?? [];
        expect(tools.map((tool) => tool.name)).toEqual(['lookup_order', 'schedule', 'stop']);
        const { properties, required } = (tools[1]?.parameters ?? {}) as {
          properties: object;
          required: string[];
        };
        expect(Object.keys(properties)).toEqual(['note', 'in', 'at']);
        expect(required).toEqual(['note']);
      });

      it('answers at once with when it will fire, and at that time its note arrives and sets the actor to work', async () => {
        const one = engine([
          calls({
            id: 'c1',
            name: 'schedule',
            arguments: { note: 'Check whether the deploy finished.', in: 0.4 },
          }),
          says('I will check later.'),
          says('Checking now.'),
        ]);
        const actor = await one.createActor();
        const started = Date.now();
        await one.say(actor.id, 'Deploy, and check on it.');
        await one.it.settled(actor.id);
        // The turn is over long before the time: nothing waited for it.
        expect(Date.now() - started).toBeLessThan(300);
        expect((await results(actor.id))[0]?.text).toMatch(
          /^scheduled for \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, in \d+ms · task t1$/,
        );
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
        expect(await one.it.tasks.list(actor.id)).toMatchObject([
          { id: 't1', kind: 'schedule', status: 'running', attached: false },
        ]);

        await quiet(one, actor.id);
        expect(Date.now() - started).toBeGreaterThanOrEqual(380);
        const [notice] = await notices(actor.id);
        expect(textOf(notice)).toMatch(
          /^<task id="t1" kind="schedule" status="done" ran="\d+ms">\nCheck whether the deploy finished\.\n<\/task>$/,
        );
        expect(textOf((await conversation(actor.id)).at(-1))).toBe('Checking now.');
        // It fired once.
        await pause(200);
        expect(await conversation(actor.id)).toHaveLength(6);
        expect(await one.it.tasks.list(actor.id)).toMatchObject([{ id: 't1', status: 'done' }]);
        expect(await one.it.getActor(actor.id)).toMatchObject({ status: 'idle' });
      });

      it('takes a time as well as a wait, and fires at once for one that has passed', async () => {
        const { one, schedule } = scripted();
        const actor = await one.createActor();
        const soon = new Date(Date.now() + 300).toISOString();
        expect((await schedule(actor.id, { note: 'a', at: soon })).text).toMatch(
          /^scheduled for .*, in \d+ms · task t1$/,
        );
        expect(
          (await schedule(actor.id, { note: 'b', at: '2020-01-01T00:00:00+05:30' })).text,
        ).toBe('scheduled for 2019-12-31T18:30:00Z, which is now · task t2');
        await quiet(one, actor.id);
        const told = (await notices(actor.id)).map(textOf);
        expect(told).toHaveLength(2);
        // One that was due long before says so.
        expect(told.find((line) => line.includes('"t2"'))).toMatch(
          /\nb\n\[this was due at 2019-12-31T18:30:00Z, and comes .* late: the engine was not running\]\n<\/task>$/,
        );
        expect(told.find((line) => line.includes('"t1"'))).toMatch(/\na\n<\/task>$/);
      });

      it('answers with what is wrong when a call does not say when, or what', async () => {
        const { one, schedule } = scripted();
        const actor = await one.createActor();
        const both = 'give one of `in`, a number of seconds, and `at`, a time';
        const time = 'at is a time with its offset, such as 2026-11-19T14:05:00Z';
        const refused: readonly (readonly [{ [name: string]: Json }, string])[] = [
          [{ note: 'a' }, both],
          [{ note: 'a', in: 5, at: '2030-01-01T00:00:00Z' }, both],
          [{ note: 'a', in: -1 }, 'in is a number of seconds, 0 or more'],
          [{ note: 'a', in: 'soon' }, 'in is a number of seconds, 0 or more'],
          [{ note: 'a', at: 'tomorrow' }, time],
          [{ note: 'a', at: '2030-01-01T00:00:00' }, time],
          [{ note: '  ', in: 5 }, 'note is what the notice will say, and is not empty'],
          [{ in: 5 }, 'note is what the notice will say, and is not empty'],
          // It is not waited for, so it takes no `wait`. And it fires once: there is no `every`.
          [{ note: 'a', in: 5, wait: 2 }, 'wait is not known'],
          [{ note: 'a', in: 5, every: 60 }, 'every is not known'],
        ];
        for (const [input, why] of refused) {
          expect(await schedule(actor.id, input)).toEqual({
            text: `The arguments of schedule are not valid: ${why}`,
            isError: true,
          });
        }
        expect(await one.it.tasks.list(actor.id)).toEqual([]);
      });

      it('takes an optional field that is empty or null as one not given, as some models send it', async () => {
        const { one, schedule } = scripted();
        const actor = await one.createActor();
        expect((await schedule(actor.id, { note: 'a', in: 50, at: '' })).text).toMatch(
          /^scheduled for .*, in \d+s · task t1$/,
        );
        expect(
          (await schedule(actor.id, { note: 'b', in: null, at: '2090-01-01T00:00:00Z' })).text,
        ).toMatch(/^scheduled for 2090-01-01T00:00:00Z, in .* · task t2$/);
        // A field the tool needs is not left out for being empty.
        expect((await schedule(actor.id, { note: '', in: 5 })).text).toBe(
          'The arguments of schedule are not valid: note is what the notice will say, and is not empty',
        );
      });

      it('is cancelled by stop, and then never fires', async () => {
        const one = engine([
          calls({ id: 'c1', name: 'schedule', arguments: { note: 'Never mind.', in: 0.4 } }),
          calls({ id: 'c2', name: 'stop', arguments: { task: 't1' } }),
          says('Cancelled.'),
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'go');
        await one.it.settled(actor.id);
        expect((await results(actor.id))[1]?.text).toMatch(
          /^stopped t1 after \d+ms\nIt had not fired\.$/,
        );
        await pause(600);
        expect(await conversation(actor.id)).toHaveLength(6);
        expect(await notices(actor.id)).toEqual([]);
        expect(await one.it.getActor(actor.id)).toMatchObject({ status: 'idle' });
      });

      it('is cancelled from outside, and the actor is told', async () => {
        const { one, script, schedule } = scripted();
        const actor = await one.createActor();
        await schedule(actor.id, { note: 'Later.', in: 30 });
        script.push(says('I see.'));
        expect(await one.it.tasks.stop(actor.id, 't1')).toMatchObject({
          status: 'stopped',
          stoppedBy: 'person',
        });
        await quiet(one, actor.id);
        expect(textOf((await notices(actor.id))[0])).toMatch(
          /^<task id="t1" kind="schedule" status="stopped" by="person" ran="\d+ms">\nIt had not fired\.\n\[stopped by a person after \d+ms\]\n<\/task>$/,
        );
      });

      it('fires at its time under the next engine, and when its time passed with none running, as soon as one is', async () => {
        const { one, schedule } = scripted();
        const actor = await one.createActor();
        expect((await schedule(actor.id, { note: 'Still on time.', in: 0.7 })).text).toMatch(
          /· task t1$/,
        );
        expect((await schedule(actor.id, { note: 'Missed while away.', in: 0.1 })).text).toMatch(
          /· task t2$/,
        );
        await one.it.close();
        // The second one's time passes with no engine at all.
        await pause(250);
        expect(await notices(actor.id)).toEqual([]);

        const two = engine([says('One.'), says('Two.')]);
        await two.it.recover();
        await quiet(two, actor.id);
        expect((await notices(actor.id)).map(textOf)).toEqual([
          expect.stringMatching(/^<task id="t2" .*\nMissed while away\.\n<\/task>$/),
          expect.stringMatching(/^<task id="t1" .*\nStill on time\.\n<\/task>$/),
        ]);
        // Not sooner than it was set for.
        const onTime = await two.it.tasks.get(actor.id, 't1');
        expect((onTime.endedAt ?? 0) - onTime.startedAt).toBeGreaterThanOrEqual(690);
      });
    });

    describe('a schedule handler', () => {
      /** An actor of the agent whose code has a schedule handler. */
      const timed = async () => {
        const made = scripted();
        await made.one.deploy(TIMED);
        const actor = await made.one.createActor();
        return { ...made, actor };
      };

      it('writes the notice of a fired schedule, given its note, when it was due and fired, and the actor', async () => {
        const { one, script, schedule, actor } = await timed();
        await schedule(actor.id, { note: 'Check the deploy.', in: 0.2 });
        script.push(says('Checking.'));
        await quiet(one, actor.id);
        const [notice] = await notices(actor.id);
        expect(textOf(notice)).toMatch(
          new RegExp(
            `^<task id="t1" kind="schedule" status="done" ran="\\d+ms">\\nCheck the deploy\\.\\n\\(one: fired not early for ${actor.id}; due \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\)\\n</task>$`,
          ),
        );
        expect(notice?.message.metadata).toEqual({
          notice: { task: 't1', kind: 'schedule', status: 'done' },
        });
        expect(textOf((await conversation(actor.id)).at(-1))).toBe('Checking.');
        expect(one.executor.made.map((call) => call.path)).toContain('schedule.handler');
      });

      it('comes before the engine’s own line on a schedule that fires late', async () => {
        const { one, schedule, actor } = await timed();
        await schedule(actor.id, { note: 'Missed.', at: '2020-01-01T00:00:00Z' });
        await quiet(one, actor.id);
        expect(textOf((await notices(actor.id))[0])).toMatch(
          /\nMissed\.\n\(one: fired not early for .*; due 2020-01-01T00:00:00\.000Z\)\n\[this was due at 2020-01-01T00:00:00Z, and comes .* late: the engine was not running\]\n<\/task>$/,
        );
      });

      it('leaves the note as it is when it fails, and keeps why with the notice, out of the model’s sight', async () => {
        const { one, steps, schedule, actor } = await timed();
        await schedule(actor.id, { note: 'throw', in: 0.1 });
        await quiet(one, actor.id);
        await schedule(actor.id, { note: 'number', in: 0.1 });
        await quiet(one, actor.id);
        const told = await notices(actor.id);
        expect(told.map(textOf)).toEqual([
          expect.stringMatching(/^<task id="t1" .*>\nthrow\n<\/task>$/),
          expect.stringMatching(/^<task id="t2" .*>\nnumber\n<\/task>$/),
        ]);
        expect(told.map((entry) => entry.message.metadata)).toEqual([
          {
            notice: {
              task: 't1',
              kind: 'schedule',
              status: 'done',
              problem: 'The schedule handler failed: no clock here',
            },
          },
          {
            notice: {
              task: 't2',
              kind: 'schedule',
              status: 'done',
              problem: 'The schedule handler failed: it returned what is not text',
            },
          },
        ]);
        const sent = JSON.stringify(steps.at(-1)?.messages);
        expect(sent).not.toContain('no clock');
        expect(sent).not.toContain('problem');
      });

      it('is the one of the version the actor is on when the schedule fires, not the newest', async () => {
        const { one, schedule } = scripted();
        // The agent as first deployed has no handler.
        const actor = await one.createActor();
        await schedule(actor.id, { note: 'Before.', in: 0.1 });
        await quiet(one, actor.id);
        // Newer code has one, and the actor is not on it yet.
        const newer = await one.deploy(TIMED, false);
        await schedule(actor.id, { note: 'Not yet.', in: 0.1 });
        await quiet(one, actor.id);
        await one.it.updateActor(actor.id, { version: newer.deployment.version });
        await schedule(actor.id, { note: 'After.', in: 0.1 });
        await quiet(one, actor.id);
        const told = await notices(actor.id);
        expect(told.map(textOf)).toEqual([
          expect.stringMatching(/\nBefore\.\n<\/task>$/),
          expect.stringMatching(/\nNot yet\.\n<\/task>$/),
          expect.stringMatching(/\nAfter\.\n\(one: fired not early for .*\)\n<\/task>$/),
        ]);
        // None of them was handed to a handler that is not there.
        expect(JSON.stringify(told.map((entry) => entry.message.metadata))).not.toContain(
          'problem',
        );
      });

      it('is not a newer version’s handler, when the actor is not on it', async () => {
        const { one, schedule, actor } = await timed();
        const pinned = await one.it.getActor(actor.id);
        await one.it.updateActor(actor.id, { version: pinned.deployment.version });
        await one.deploy(NEWER);
        await schedule(actor.id, { note: 'Which?', in: 0.1 });
        await quiet(one, actor.id);
        expect(textOf((await notices(actor.id))[0])).toMatch(/\nWhich\?\n\(one: fired not early/);
      });

      it('has fired once it runs: a stop that comes while it does is too late to stop it', async () => {
        const { one, schedule, actor } = await timed();
        await schedule(actor.id, { note: 'slow', in: 0.1 });
        await pause(250);
        await one.it.tasks.stop(actor.id, 't1').catch(() => undefined);
        await quiet(one, actor.id);
        const [notice] = (await notices(actor.id)).map(textOf);
        expect(notice).toMatch(/\nslow\n\(one: fired not early/);
        expect(notice).not.toContain('It had not fired');
      });
    });
  });
}
