// Subagents, through the whole engine, on any store: an actor spawns others and they talk by
// messages, and stopping an actor stops the actors it spawned. One model answers every actor,
// each by what its agent tells it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelStep } from '@acentric/ai';
import { calls, says } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import type { Actor, ActorId, ConversationEntry, Json, MachineId } from '@acentric/protocol';

import { Secrets } from '../src/secrets.ts';
import type { Store } from '../src/store.ts';
import { wrapMessage } from '../src/subagents.ts';
import type { AgentFunction } from '../src/testing.ts';
import { NOTICE } from '../src/tasks.ts';
import { MANIFEST, eventually, over, world } from './world.ts';
import type { World } from './world.ts';

/** What a message says, as text. */
function textOf(entry: ConversationEntry | undefined): string {
  const { content } = (entry?.message ?? {}) as {
    content?: readonly { readonly type: string; readonly text?: string }[];
  };
  return (content ?? []).map((part) => part.text ?? `[${part.type}]`).join('');
}

/** What each agent tells its model: the model's answers are chosen by it. */
const LEAD = 'You lead.';
const HELP = 'You help.';
const PLAIN = 'You review changes.';

const spawn = (id: string, args: { [name: string]: Json }) =>
  calls({ id, name: 'spawn_agent', arguments: args });
const tell = (id: string, to: string, message: string) =>
  calls({ id, name: 'message_agent', arguments: { to, message } });

export function subagentsSuite(name: string, open: () => Promise<Store>): void {
  describe(`subagents, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    let engines: ReturnType<World['engine']>[];

    /**
     * An engine with the agents `lead`, which can spawn `helper` and `plain`, and those two.
     * `helper` can spawn `plain` too. Its model answers each actor from its agent's own steps.
     */
    const setup = async (
      steps: { [instructions: string]: Scripted[] },
      code: {
        readonly create?: AgentFunction;
        readonly lookup?: AgentFunction;
      } = {},
      on: World = w,
    ) => {
      const sent: ModelStep[] = [];
      const one = on.engine(
        {
          run: async (step, signal) => {
            sent.push(structuredClone(step));
            const of = Object.keys(steps).find((own) => step.instructions.endsWith(own));
            // With nothing said of what it does next, it says a word and ends its turn.
            const next = (of === undefined ? undefined : steps[of]?.shift()) ?? says('ok');
            return typeof next === 'function' ? next(step, signal) : next;
          },
        },
        {
          ...(code.lookup === undefined ? {} : { lookup: code.lookup }),
          versions: {
            'lead@1': {
              definition: {
                instructions: LEAD,
                features: ['subagents'],
                subagents: [
                  { agent: 'helper', description: 'Does part of the work.', creates: false },
                  {
                    agent: 'plain',
                    description: 'Reviews a change.',
                    creates: true,
                    schema: {
                      type: 'object',
                      properties: {
                        strict: { type: 'boolean', description: 'How hard it looks.' },
                      },
                      required: ['strict'],
                    },
                  },
                  { agent: 'nowhere', description: 'Is not deployed.', creates: false },
                ],
              },
              functions: {
                'subagents.plain.create':
                  code.create ??
                  ((args) => ({
                    reasoning: (args as { strict?: boolean }).strict === true ? 'high' : 'low',
                    configuration: { asked: args },
                  })),
              },
            },
            'helper@1': {
              definition: {
                instructions: HELP,
                features: ['subagents'],
                subagents: [{ agent: 'plain', description: 'Reviews a change.', creates: false }],
              },
            },
            'plain@1': {
              definition: { instructions: PLAIN, configuration: { schema: null } },
              functions: { 'configuration.validate': (given) => given },
            },
          },
          options: { clock: Date.now, taskTimes: { floorMs: 60 } },
        },
      );
      engines.push(one);
      const deploy = (agent: string) =>
        one.it.deploy({ agent, manifest: MANIFEST, code: `${agent}@1` });
      const lead = await deploy('lead');
      await deploy('helper');
      await deploy('plain');
      const actor = (await one.it.createActor({ agent: lead.agent.id })).actor;
      return { one, sent, actor, say: (text: string) => one.say(actor.id, text) };
    };
    type Made = Awaited<ReturnType<typeof setup>>;

    const conversation = (actor: ActorId) => store.conversation(actor);
    const lines = async (actor: ActorId) =>
      (await conversation(actor)).map((entry) => `${entry.message.role}: ${textOf(entry)}`);
    const results = async (actor: ActorId) =>
      (await conversation(actor))
        .filter((entry) => entry.message.role === 'tool_result')
        .map((entry) => ({
          text: textOf(entry),
          isError: (entry.message as { isError?: boolean }).isError === true,
        }));
    const child = async (made: Made, called: string, parent = made.actor.id): Promise<Actor> => {
      const found = await store.findChild(parent, called);
      if (found === undefined) throw new Error(`There is no subagent ${called}`);
      return found.actor;
    };
    /** Until no actor of the engine has a turn going on or mail that starts one. */
    const quiet = async (made: Made) => {
      await expect
        .poll(
          async () => {
            await made.one.it.settled();
            return (await store.unfinished()).length;
          },
          { timeout: 10_000, interval: 10 },
        )
        .toBe(0);
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

    describe('the tools', () => {
      it('are offered to an actor that can have subagents, with the agents it can create one of', async () => {
        const made = await setup({});
        await made.say('Hello.');
        await quiet(made);
        const tools = made.sent[0]?.tools ?? [];
        expect(tools.map((tool) => tool.name)).toEqual([
          'lookup_order',
          'schedule',
          'stop',
          'spawn_agent',
          'message_agent',
        ]);
        const described = tools.find((tool) => tool.name === 'spawn_agent')?.description ?? '';
        expect(described).toMatch(/^Creates a subagent: another agent that works for you/);
        expect(described).toContain(
          [
            'The agents you can create one of:',
            '- helper: Does part of the work.',
            '- plain: Reviews a change.',
            '  params: {',
            '    // How hard it looks.',
            '    strict: boolean;',
            '  }',
            '- nowhere: Is not deployed.',
          ].join('\n'),
        );
        expect(tools.find((tool) => tool.name === 'message_agent')?.description).toBe(
          'Sends a message to one of your subagents, by the name you gave it. It is sent, and you are not answered here: when the other has something to say, a message arrives for you, marked with who it is from. A message that reaches an agent at work joins what it is doing; one that reaches an idle agent sets it to work.',
        );
        // `stop` says that it stops one of them, too.
        expect(tools.find((tool) => tool.name === 'stop')?.description).toContain(
          'With the name of one of your subagents, it stops the subagent',
        );
        expect(made.sent[0]?.instructions).toContain('# Subagents\n\nYou can create other agents');
        expect(made.sent[0]?.instructions).not.toContain('# You are a subagent');
      });

      it('are a way to its parent for a subagent, and none for an actor that is neither', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'plain', name: 'reviewer', params: { strict: true } }),
            tell('c2', 'reviewer', 'Look at change 7.'),
          ],
        });
        await made.say('Review change 7.');
        await quiet(made);
        const reviewer = made.sent.find((step) => step.instructions.endsWith(PLAIN));
        expect(reviewer?.tools.map((tool) => tool.name)).toEqual([
          'lookup_order',
          'schedule',
          'stop',
          'message_agent',
        ]);
        expect(reviewer?.tools.at(-1)?.description).toMatch(
          /^Sends a message to `parent`, the agent that created you\./,
        );
        expect(reviewer?.instructions).toContain('# You are a subagent');
        expect(reviewer?.instructions).not.toContain('# Subagents');
        expect(reviewer?.tools[2]?.description).not.toContain('subagents');

        // One created from outside, of an agent that lists none, has neither.
        const plain = await made.one.it.findAgent('plain');
        const alone = (await made.one.it.createActor({ agent: plain?.id as never })).actor;
        await made.one.say(alone.id, 'Hello.');
        await quiet(made);
        expect(made.sent.at(-1)?.tools.map((tool) => tool.name)).toEqual([
          'lookup_order',
          'schedule',
          'stop',
        ]);
      });
    });

    describe('a subagent', () => {
      it('is created idle, is given work by a message, and reports by one, which sets its parent to work', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            tell('c2', 'worker', 'Count the orders of May.'),
            says('I asked worker.'),
            says('There were 41.'),
          ],
          [HELP]: [tell('h1', 'parent', 'There were 41 orders in May.'), says('Completed')],
        });
        await made.say('How many orders in May?');
        await quiet(made);
        const worker = await child(made, 'worker');
        expect(worker).toMatchObject({
          parent: { id: made.actor.id, name: 'worker' },
          status: 'idle',
          name: null,
        });
        expect(await made.one.it.children(made.actor.id)).toMatchObject([{ id: worker.id }]);
        expect(await lines(made.actor.id)).toEqual([
          'user: How many orders in May?',
          'assistant: [tool_call]',
          `tool_result: Created worker, one of helper (${worker.id}). It is idle until it is sent a message.`,
          'assistant: [tool_call]',
          'tool_result: Sent to worker.',
          'assistant: I asked worker.',
          `system: ${wrapMessage('worker', 'There were 41 orders in May.')}`,
          'assistant: There were 41.',
        ]);
        expect(await lines(worker.id)).toEqual([
          `user: ${wrapMessage('parent', 'Count the orders of May.')}`,
          'assistant: [tool_call]',
          'tool_result: Sent to parent.',
          'assistant: Completed',
        ]);
        // Who each message is from is kept with it.
        const [down] = await conversation(worker.id);
        expect(down?.message.metadata).toEqual({ agent: { from: made.actor.id, name: 'parent' } });
        const up = (await conversation(made.actor.id))[6];
        expect(up?.message.metadata).toEqual({ agent: { from: worker.id, name: 'worker' } });
        expect(up?.input?.type).toBe('notice');
        expect(down?.input?.type).toBe('agent');
      });

      it('sends nothing more of an answer when the turn is ended while an agent is created', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const made = await setup(
          {
            [LEAD]: [
              // A subagent there is already.
              spawn('c0', { agent: 'helper', name: 'rev' }),
              says('Made.'),
              // Then one more, and a message to the first in the same answer.
              calls(
                {
                  id: 'c1',
                  name: 'spawn_agent',
                  arguments: { agent: 'plain', name: 'strict', params: { strict: true } },
                },
                { id: 'c2', name: 'message_agent', arguments: { to: 'rev', message: 'Begin.' } },
              ),
            ],
          },
          {
            // Its agent's code is slow to say how it is made: the turn is ended meanwhile.
            create: async (args) => {
              await held;
              return { configuration: { asked: args } };
            },
          },
        );
        await made.say('Make one.');
        await quiet(made);
        await made.say('Go.');
        await eventually(() =>
          made.one.executor.made.some((call) => call.path === 'subagents.plain.create'),
        );
        const interrupted = made.one.it.interrupt(made.actor.id);
        release();
        await interrupted;
        await quiet(made);
        expect(await lines((await child(made, 'rev')).id)).toEqual([]);
      });

      it('is created before anything of the same answer is sent to it', async () => {
        const made = await setup({
          [LEAD]: [
            calls(
              { id: 'c1', name: 'message_agent', arguments: { to: 'worker', message: 'Begin.' } },
              { id: 'c2', name: 'spawn_agent', arguments: { agent: 'helper', name: 'worker' } },
            ),
          ],
        });
        await made.say('Go.');
        await quiet(made);
        expect((await results(made.actor.id)).map((result) => result.text).toSorted()).toEqual([
          expect.stringMatching(/^Created worker, one of helper/),
          'Sent to worker.',
        ]);
        expect((await lines((await child(made, 'worker')).id))[0]).toBe(
          `user: ${wrapMessage('parent', 'Begin.')}`,
        );
      });

      it('is created with what its agent’s code says of it, from what the model gave', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'plain', name: 'strict', params: { strict: true } }),
            spawn('c2', { agent: 'plain', name: 'lax', params: { strict: false } }),
          ],
        });
        await made.say('Review.');
        await quiet(made);
        expect(await child(made, 'strict')).toMatchObject({
          reasoning: 'high',
          configuration: { asked: { strict: true } },
        });
        expect(await child(made, 'lax')).toMatchObject({ reasoning: 'low' });
        expect(made.one.executor.made.map((call) => call.path)).toContain('subagents.plain.create');
        // One whose agent says nothing of how is created with the defaults, and no code is asked.
        expect(
          made.one.executor.made.filter((call) => call.path === 'subagents.helper.create'),
        ).toEqual([]);
      });

      it('is not created for what cannot be: the answer says what is wrong', async () => {
        const refused: readonly (readonly [{ [name: string]: Json }, string])[] = [
          [
            { agent: 'stranger', name: 'a' },
            'There is no agent stranger for you to create one of. There are: helper, plain, nowhere',
          ],
          [
            { agent: 'helper', name: 'two words' },
            'name is 1 to 64 letters, digits, _ or -, starting with a letter or a digit',
          ],
          [
            { agent: 'helper' },
            'name is 1 to 64 letters, digits, _ or -, starting with a letter or a digit',
          ],
          [
            { agent: 'helper', name: 'parent' },
            "parent is what a subagent calls you: it cannot be one's name",
          ],
          [{ agent: 'helper', name: 'a', params: 'none' }, 'params is an object'],
          [{ agent: 'helper', name: 'a', machine: 'laptop' }, 'machine is not known'],
          [
            { agent: 'plain', name: 'a', params: { strict: true } },
            'plain could not be created: no reviewer on a Sunday',
          ],
          [
            { agent: 'nowhere', name: 'a' },
            'The agent nowhere is not deployed, so none can be created',
          ],
        ];
        const script: Scripted[] = refused.map(([args], index) => spawn(`c${String(index)}`, args));
        const again = await setup(
          { [LEAD]: script },
          {
            create: () => {
              throw new Error('no reviewer on a Sunday');
            },
          },
        );
        for (const [index] of refused.entries()) {
          await again.say(`Try ${String(index)}.`);
          await quiet(again);
        }
        const answered = await results(again.actor.id);
        expect(answered.map((one) => one.isError)).toEqual(refused.map(() => true));
        // Each is told what is wrong with it, in the order they were asked.
        expect(answered.map((one) => one.text)).toEqual(refused.map(([, why]) => why));
        expect(await again.one.it.children(again.actor.id)).toEqual([]);
      });

      it('has a name no other of its parent’s has, and the same call made again makes the same one', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            spawn('c2', { agent: 'helper', name: 'worker' }),
            // As a call a restart cut off is made again: with the ID it had.
            spawn('c1', { agent: 'helper', name: 'worker' }),
          ],
        });
        for (const text of ['One.', 'Two.', 'Three.']) {
          await made.say(text);
          await quiet(made);
        }
        const worker = await child(made, 'worker');
        const created = `Created worker, one of helper (${worker.id}). It is idle until it is sent a message.`;
        expect((await results(made.actor.id)).map((one) => one.text)).toEqual([
          created,
          'You have a subagent worker already. Send it a message with message_agent.',
          created,
        ]);
        expect(await made.one.it.children(made.actor.id)).toHaveLength(1);
      });

      it('can have subagents of its own, and each talks only with the one above and the ones below', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            tell('c2', 'worker', 'Have change 7 reviewed.'),
          ],
          [HELP]: [
            spawn('h1', { agent: 'plain', name: 'reviewer' }),
            tell('h2', 'reviewer', 'Review change 7.'),
            says('Waiting.'),
            tell('h3', 'parent', 'Change 7 is fine.'),
            says('Completed'),
          ],
          [PLAIN]: [tell('p1', 'parent', 'It is fine.'), says('Completed')],
        });
        await made.say('Review change 7.');
        await quiet(made);
        const worker = await child(made, 'worker');
        const reviewer = await child(made, 'reviewer', worker.id);
        expect(reviewer.parent).toEqual({ id: worker.id, name: 'reviewer' });
        expect((await lines(worker.id)).filter((line) => line.startsWith('system'))).toEqual([
          `system: ${wrapMessage('reviewer', 'It is fine.')}`,
        ]);
        expect((await lines(made.actor.id)).at(-2)).toBe(
          `system: ${wrapMessage('worker', 'Change 7 is fine.')}`,
        );
        // The one at the top has no subagent of that name: it is its subagent's.
        expect(await store.findChild(made.actor.id, 'reviewer')).toBeUndefined();
      });

      it('is not sent what cannot be said, or said to no one: the answer says what is wrong', async () => {
        const made = await setup({
          [LEAD]: [
            tell('c1', 'worker', 'Begin.'),
            spawn('c2', { agent: 'helper', name: 'worker' }),
            tell('c3', 'other', 'Begin.'),
            tell('c4', 'worker', '  '),
            tell('c5', 'parent', 'Hello?'),
            calls({
              id: 'c6',
              name: 'message_agent',
              arguments: { to: 'worker', message: 'a', now: true },
            }),
          ],
        });
        for (let turn = 0; turn < 6; turn += 1) {
          await made.say(`Turn ${String(turn)}.`);
          await quiet(made);
        }
        expect((await results(made.actor.id)).map((one) => one.text)).toEqual([
          'You have no subagent worker. You have none: create one with spawn_agent.',
          expect.stringMatching(/^Created worker/),
          'You have no subagent other. You have: worker',
          'message is what to say, and is not empty',
          'You have no parent: no agent created you',
          'now is not known',
        ]);
        // Nothing was sent to the one it has.
        expect(await conversation((await child(made, 'worker')).id)).toEqual([]);
      });
    });

    describe('a subagent and its parent’s machine', () => {
      /** A lead on a machine, with variables, that can spawn one that works on a machine and one that does not. */
      const onMachine = async (create?: AgentFunction) => {
        const one = w.engine(
          [
            spawn('c1', { agent: 'helper', name: 'beside' }),
            spawn('c2', { agent: 'plain', name: 'apart' }),
            spawn('c3', { agent: 'moved', name: 'elsewhere' }),
          ],
          {
            versions: {
              'lead@1': {
                definition: {
                  instructions: LEAD,
                  features: ['subagents', 'machine'],
                  subagents: [
                    { agent: 'helper', description: 'Works beside you.', creates: false },
                    { agent: 'plain', description: 'Has no machine.', creates: false },
                    { agent: 'moved', description: 'Works where it is told.', creates: true },
                  ],
                },
                functions: { 'subagents.moved.create': create ?? (() => ({ machine: null })) },
              },
              'helper@1': { definition: { instructions: HELP, features: ['machine'] } },
              'plain@1': { definition: { instructions: PLAIN } },
              'moved@1': { definition: { instructions: HELP, features: ['machine'] } },
            },
            options: {
              clock: Date.now,
              machines: {},
              secrets: new Secrets({
                store,
                keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } },
              }),
            },
          },
        );
        engines.push(one);
        const deployed = new Map<string, string>();
        for (const agent of ['lead', 'helper', 'plain', 'moved']) {
          const made = await one.it.deploy({ agent, manifest: MANIFEST, code: `${agent}@1` });
          deployed.set(agent, made.agent.id);
        }
        const added = await one.it.machines?.add({ name: 'laptop', agents: '*' });
        const machine = added?.machine.id as MachineId;
        const { actor } = await one.it.createActor({
          agent: deployed.get('lead') as never,
          machine: { id: machine, cwd: '~/work', env: { ORDERS_API_KEY: 'sk-secret-value' } },
        });
        return { one, actor, machine };
      };

      it('works where its parent does, with the variables its parent has, unless its agent has no machine', async () => {
        const { one, actor, machine } = await onMachine();
        for (const text of ['One.', 'Two.', 'Three.']) {
          await one.say(actor.id, text);
          await one.it.settled(actor.id);
        }
        const beside = (await store.findChild(actor.id, 'beside'))?.actor;
        expect(beside?.machine).toEqual({ id: machine, cwd: '~/work', env: ['ORDERS_API_KEY'] });
        // The variables are its own now, sealed as its own: they open as no other actor's.
        const kept = await store.actorEnv(beside?.id as ActorId);
        expect(kept).toBeTypeOf('string');
        expect(kept).not.toBe(await store.actorEnv(actor.id));
        expect(kept).not.toContain('sk-secret-value');
        // One whose agent's actors have no machine has none.
        expect((await store.findChild(actor.id, 'apart'))?.actor.machine).toBeNull();
        // And one that works on a machine cannot be created with none: the answer says so.
        const answered = (await store.conversation(actor.id))
          .filter((entry) => entry.message.role === 'tool_result')
          .map(textOf);
        expect(answered[2]).toMatch(/^moved could not be created: .*works on a machine/);
        expect(await store.findChild(actor.id, 'elsewhere')).toBeUndefined();
      });

      it('works where its agent’s code says, when it says', async () => {
        let given: Json = null;
        const { one, actor, machine } = await onMachine((_args, context) => {
          given = context.machine as Json;
          return {
            machine: {
              id: context.machine?.id ?? null,
              cwd: '/srv',
              env: { EXTRA: 'from-create' },
            },
          };
        });
        for (const text of ['One.', 'Two.', 'Three.']) {
          await one.say(actor.id, text);
          await one.it.settled(actor.id);
        }
        // The code is given its actor's machine as data, with the variables.
        expect(given).toEqual({
          id: machine,
          cwd: '~/work',
          env: { ORDERS_API_KEY: 'sk-secret-value' },
        });
        expect((await store.findChild(actor.id, 'elsewhere'))?.actor.machine).toEqual({
          id: machine,
          cwd: '/srv',
          env: ['EXTRA'],
        });
      });
    });

    describe('what a tree of subagents used', () => {
      it('is added up under the actor at its top, and each actor knows the ones above it', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            tell('c2', 'worker', 'Have change 7 reviewed.'),
          ],
          [HELP]: [
            spawn('h1', { agent: 'plain', name: 'reviewer' }),
            tell('h2', 'reviewer', 'Review change 7.'),
          ],
        });
        await made.say('Review change 7.');
        await quiet(made);
        const worker = await child(made, 'worker');
        const reviewer = await child(made, 'reviewer', worker.id);
        expect((await made.one.it.lineage(reviewer.id)).map((one) => one.id)).toEqual([
          reviewer.id,
          worker.id,
          made.actor.id,
        ]);
        const byRoot = await made.one.it.usage({}, 'root');
        expect(byRoot.groups?.map((group) => group.key)).toEqual([made.actor.id]);
        expect(byRoot.groups?.[0]?.totals.calls).toBe(byRoot.totals.calls);
        const byActor = await made.one.it.usage({ root: made.actor.id }, 'actor');
        expect(byActor.groups?.map((group) => group.key).toSorted()).toEqual(
          [made.actor.id, worker.id, reviewer.id].toSorted(),
        );
        expect((await made.one.it.usage({ root: worker.id })).totals.calls).toBe(0);
      });

      it('takes no message once it is put away: the answer says so', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            tell('c2', 'worker', 'Begin.'),
            says('Asked.'),
            tell('c3', 'worker', 'One more thing.'),
          ],
        });
        await made.say('One.');
        await quiet(made);
        const worker = await child(made, 'worker');
        await made.one.it.archive(worker.id);
        await quiet(made);
        await made.say('Two.');
        await quiet(made);
        expect((await results(made.actor.id)).at(-1)).toEqual({
          text: 'worker is archived: it takes nothing until it is unarchived',
          isError: true,
        });
      });
    });

    describe('a message, when the engine stops before its call is answered', () => {
      it('is said once: the call made again by the next engine says nothing twice', async () => {
        // An engine whose store takes nothing more once the message is in the worker's mailbox.
        let said = false;
        const stuck = over(store, {
          addInput: async (input) => {
            const added = await store.addInput(input);
            if (input.externalId?.startsWith('agent:') === true) said = true;
            return added;
          },
          commit: (...given) => (said ? new Promise(() => {}) : store.commit(...given)),
        });
        const first = await setup(
          {
            [LEAD]: [
              spawn('c1', { agent: 'helper', name: 'worker' }),
              tell('c2', 'worker', 'Look up order 4411.'),
            ],
          },
          {},
          world({ store: stuck }),
        );
        // It is gone, not closed.
        engines.pop();
        await first.say('Find order 4411.');
        await expect.poll(() => said, { timeout: 10_000, interval: 10 }).toBe(true);
        const worker = await child(first, 'worker');
        expect(await results(first.actor.id)).toHaveLength(1);

        const next = await setup({ [LEAD]: [says('I asked worker.')] });
        await next.one.it.recover();
        await quiet(next);
        // The call was made again, and answered.
        expect(await results(first.actor.id)).toEqual([
          expect.objectContaining({ isError: false }),
          { text: 'Sent to worker.', isError: false },
        ]);
        expect(
          (await lines(worker.id)).filter((line) => line.includes('Look up order 4411.')),
        ).toEqual([`user: ${wrapMessage('parent', 'Look up order 4411.')}`]);
      });
    });

    describe('stopping', () => {
      /** A lead whose worker is in the middle of a turn that does not end by itself. */
      const working = async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const made = await setup(
          {
            [LEAD]: [
              spawn('c1', { agent: 'helper', name: 'worker' }),
              tell('c2', 'worker', 'Look up order 4411.'),
              says('I asked worker.'),
            ],
            [HELP]: [
              spawn('h1', { agent: 'plain', name: 'reviewer' }),
              calls({ id: 'h2', name: 'lookup_order', arguments: { id: 4411 } }),
            ],
          },
          {
            lookup: async () => {
              await held;
              return 'found';
            },
          },
        );
        await made.say('Find order 4411.');
        const worker = await expect
          .poll(async () => (await store.findChild(made.actor.id, 'worker'))?.actor, {
            timeout: 10_000,
            interval: 10,
          })
          .toBeDefined()
          .then(() => child(made, 'worker'));
        await expect
          .poll(async () => (await results(worker.id)).length, { timeout: 10_000, interval: 10 })
          .toBe(1);
        return { ...made, worker, release };
      };

      it('by its parent stops a subagent in the middle of its turn, and its own subagents with it', async () => {
        const made = await working();
        const { one, actor, worker, release } = made;
        await one.it.settled(actor.id);
        const stopped = await one.it.abort(worker.id, 'parent');
        release();
        expect(stopped).toMatchObject({ interrupted: true, tasks: [], agents: ['reviewer'] });
        expect(stopped.actor.status).toBe('idle');
        await quiet(made);
        // It is not gone: it is idle, and can be sent more.
        expect(await one.it.getActor(worker.id)).toMatchObject({
          status: 'idle',
          lastTurn: { end: 'interrupted' },
        });
        // Its parent did it, and is told nothing of what it did itself.
        expect((await lines(actor.id)).filter((line) => line.includes('<agent '))).toEqual([]);
      });

      it('by the model, with `stop` and the name, answers with what was stopped', async () => {
        const made = await setup({
          [LEAD]: [
            spawn('c1', { agent: 'helper', name: 'worker' }),
            calls({ id: 'c2', name: 'stop', arguments: { task: 'worker' } }),
            calls({ id: 'c3', name: 'stop', arguments: { task: 'nobody' } }),
          ],
        });
        for (const text of ['One.', 'Two.', 'Three.']) {
          await made.say(text);
          await quiet(made);
        }
        expect((await results(made.actor.id)).slice(1)).toEqual([
          {
            text: 'stopped worker: it was doing nothing. It is idle, and can be sent more.',
            isError: false,
          },
          { text: 'There is no task nobody. No task is running.', isError: true },
        ]);
      });

      it('an actor from outside stops the actors it spawned, and theirs, and says which', async () => {
        const made = await working();
        const { one, actor, worker, release } = made;
        await one.it.settled(actor.id);
        const stopped = await one.it.abort(actor.id);
        release();
        expect(stopped).toMatchObject({ interrupted: false, agents: ['worker'] });
        await quiet(made);
        expect((await one.it.getActor(worker.id)).lastTurn).toMatchObject({ end: 'interrupted' });
        expect(await store.listStopping()).toEqual([]);
      });

      it('a subagent from outside tells its parent, which would otherwise wait for ever', async () => {
        const made = await working();
        const { one, actor, worker, release } = made;
        await one.it.settled(actor.id);
        const stopped = await one.it.abort(worker.id);
        release();
        expect(stopped).toMatchObject({ interrupted: true, agents: ['reviewer'] });
        await quiet(made);
        const told = (await conversation(actor.id)).find((entry) =>
          textOf(entry).startsWith('<agent '),
        );
        expect(textOf(told)).toBe('<agent name="worker" status="aborted" by="person"/>');
        expect(told?.message.metadata).toEqual({
          agent: { from: worker.id, name: 'worker', status: 'aborted' },
        });
        // It set the parent to work: its model was called once more.
        expect((await lines(actor.id)).at(-1)).toBe('assistant: ok');
        // The one below it was stopped by its parent, and that parent is told nothing.
        expect((await lines(worker.id)).filter((line) => line.includes('<agent '))).toEqual([]);
      });

      it('by archiving puts away the actors it spawned too, and taking it out takes them out', async () => {
        const made = await working();
        const { one, actor, worker, release } = made;
        await one.it.settled(actor.id);
        const archived = await one.it.archive(actor.id);
        release();
        expect(archived.status).toBe('archived');
        const reviewer = await child(made, 'reviewer', worker.id);
        expect((await one.it.getActor(worker.id)).status).toBe('archived');
        expect((await one.it.getActor(reviewer.id)).status).toBe('archived');
        expect((await one.it.unarchive(actor.id)).status).toBe('idle');
        expect((await one.it.getActor(worker.id)).status).toBe('idle');
        expect((await one.it.getActor(reviewer.id)).status).toBe('idle');
        expect(await store.listStopping()).toEqual([]);
      });

      it('is written down before anything is stopped, for each actor of the tree, and crossed out after', async () => {
        const written: [string, unknown][] = [];
        const watched = over(store, {
          setStopping: async (actor, stopping) => {
            written.push([actor, stopping]);
            await store.setStopping(actor, stopping);
          },
        });
        const made = await setup(
          { [LEAD]: [spawn('c1', { agent: 'helper', name: 'worker' })] },
          {},
          world({ store: watched }),
        );
        await made.say('Start.');
        await quiet(made);
        const worker = await child(made, 'worker');
        await made.one.it.abort(made.actor.id);
        expect(written).toEqual([
          [made.actor.id, { how: 'abort', by: 'person' }],
          [worker.id, { how: 'abort', by: 'parent' }],
          [worker.id, null],
          [made.actor.id, null],
        ]);
      });

      it('leaves what a subagent said while it was being stopped for the next turn: it starts none', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let lead: Made | undefined;
        // The worker reports just as it is about to be stopped.
        const reporting = over(store, {
          setStopping: async (actor, stopping) => {
            if (lead !== undefined && actor !== lead.actor.id && stopping !== null) {
              const { one, actor: parent } = lead;
              release();
              await eventually(async () =>
                (await one.it.listInputs(parent.id)).items.some((input) => input.type === NOTICE),
              );
            }
            await store.setStopping(actor, stopping);
          },
        });
        const made = await setup(
          {
            [LEAD]: [
              spawn('c1', { agent: 'helper', name: 'worker' }),
              tell('c2', 'worker', 'Look up order 4411.'),
              says('I asked worker.'),
            ],
            [HELP]: [
              async () => {
                await held;
                return tell('h1', 'parent', 'It was refunded twice.');
              },
            ],
          },
          {},
          world({ store: reporting }),
        );
        lead = made;
        await made.say('Find order 4411.');
        await made.one.it.settled(made.actor.id);
        await expect
          .poll(() => made.sent.filter((step) => step.instructions.endsWith(HELP)).length, {
            timeout: 10_000,
            interval: 10,
          })
          .toBe(1);
        const before = (await lines(made.actor.id)).length;

        await made.one.it.abort(made.actor.id);
        await quiet(made);
        // The report is in its mailbox, and set it to nothing.
        expect(await lines(made.actor.id)).toHaveLength(before);
        // The next turn, which a person starts, has it.
        await made.say('Anything?');
        await quiet(made);
        expect((await lines(made.actor.id)).slice(before)).toEqual([
          `system: ${wrapMessage('worker', 'It was refunded twice.')}`,
          'user: Anything?',
          'assistant: ok',
        ]);
      });

      it('is gone on with by the next engine, when the one that began it went away', async () => {
        const made = await working();
        const { one, actor, worker, release } = made;
        await one.it.settled(actor.id);
        // As an engine leaves things when it goes away in the middle: written down, not done.
        await store.setStopping(actor.id, { how: 'abort', by: 'person' });
        release();
        await one.it.close({ graceMs: 50 });
        expect(await store.listStopping()).toEqual([
          { actor: actor.id, how: 'abort', by: 'person' },
        ]);

        const next = await setup({});
        await next.one.it.recover();
        await expect
          .poll(() => store.listStopping(), { timeout: 10_000, interval: 10 })
          .toEqual([]);
        await next.one.it.settled();
        expect((await next.one.it.getActor(worker.id)).status).toBe('idle');
        expect((await store.unfinished()).filter((id) => id === worker.id)).toEqual([]);
      });
    });
  });
}
