// Code mode, through the whole engine, on any store: a model calls `code` with a script, the
// script runs in the real sandbox, and its calls reach the agent's own tools.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelStep } from '@acentric/ai';
import { calls, says } from '@acentric/ai/testing';
import type { Scripted } from '@acentric/ai/testing';
import type { ActorId, ConversationEntry, Json } from '@acentric/protocol';

import type { Store } from '../src/store.ts';
import type { TaskTimes } from '../src/tasks.ts';
import { Invalid, Lost } from '../src/testing.ts';
import { MANIFEST, eventually, over, world } from './world.ts';
import type { World } from './world.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TIMES: Partial<TaskTimes> = { defaultWaitMs: 3000, floorMs: 60, stopGraceMs: 1000 };

/** A PNG as its file starts: enough to know it by. What is in it is no one's to read here. */
const PIXELS = (() => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(8, 16);
  bytes.writeUInt32BE(8, 20);
  return bytes.toString('base64');
})();

const parameters = (properties: { [name: string]: Json }, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});

/** A conversation as lines: who said it, and what. */
function lineOf(entry: ConversationEntry): string {
  const { message } = entry;
  const { content } = message as {
    content?: readonly { readonly type: string; readonly text?: string }[];
  };
  const text = (content ?? []).map((part) => part.text ?? `[${part.type}]`).join('');
  if (message.role === 'tool_result') {
    return `result${message.isError === true ? ' (error)' : ''}: ${text}`;
  }
  return `${message.role === 'system' ? 'notice' : message.role}: ${text}`;
}

export function codeSuite(name: string, open: () => Promise<Store>): void {
  describe(`code mode, on a store ${name}`, () => {
    let store: Store;
    let w: World;
    let engines: ReturnType<World['engine']>[];
    /** What the agent's tools were called with, in order: of every engine on the store. */
    let made: string[];
    let nextCall: number;

    /**
     * An engine with the agent `scripted`: one tool the model calls itself, and the rest for
     * its scripts. Its model does what `script` says, in order, and says a word after that.
     */
    const setup = async (of?: ActorId, on: World = w) => {
      const steps: ModelStep[] = [];
      const script: Scripted[] = [];
      const runner = {
        run: async (step: ModelStep, signal: AbortSignal) => {
          steps.push(structuredClone(step));
          const next = script.shift() ?? says('ok');
          return typeof next === 'function' ? next(step, signal) : next;
        },
      };
      const noted = (what: string, args: Json): void => {
        made.push(
          `${what}:${String((args as { text?: string; id?: string }).text ?? (args as { id?: string }).id ?? '')}`,
        );
      };
      const one = on.engine(runner, {
        versions: {
          'scripted@1': {
            definition: {
              instructions: 'You run scripts.',
              features: ['codemode'],
              tools: [
                {
                  name: 'direct',
                  description: 'A tool the model calls itself.',
                  parameters: parameters({}),
                  retrySafe: true,
                },
                {
                  name: 'lookup_order',
                  description: 'Looks an order up by its ID. Answers JSON.',
                  parameters: parameters({ id: { type: 'string' } }, ['id']),
                  retrySafe: true,
                  codemode: true,
                },
                {
                  name: 'shout',
                  description: 'Says a text loudly.',
                  parameters: parameters({ text: { type: 'string' } }, ['text']),
                  retrySafe: true,
                  codemode: true,
                },
                {
                  name: 'explode',
                  description: 'Fails.',
                  parameters: parameters({}),
                  retrySafe: true,
                  codemode: true,
                },
                {
                  name: 'snapshot',
                  description: 'Takes a picture of the shelf.',
                  parameters: parameters({}),
                  retrySafe: true,
                  codemode: true,
                },
                {
                  name: 'add_note',
                  description: 'Writes a note down. With `ms`, it takes that long.',
                  parameters: parameters({ text: { type: 'string' }, ms: { type: 'number' } }, [
                    'text',
                  ]),
                  retrySafe: false,
                  codemode: true,
                },
                {
                  name: 'count-stock',
                  description:
                    'How many of an item are left in stock. With `ms`, it takes that long.',
                  parameters: parameters({ text: { type: 'string' }, ms: { type: 'number' } }, [
                    'text',
                  ]),
                  retrySafe: true,
                  codemode: true,
                },
                {
                  name: 'vanish',
                  description: 'Is lost with the call in it.',
                  parameters: parameters({}),
                  retrySafe: false,
                  codemode: true,
                },
              ],
            },
            functions: {
              'tools.direct.execute': () => 'direct',
              'tools.lookup_order.execute': (args) => {
                const { id } = args as { id?: unknown };
                if (typeof id !== 'string') {
                  throw new Invalid({ message: 'Expected a string', path: ['id'] });
                }
                noted('lookup_order', args);
                return JSON.stringify({ id, lines: 3, total: 30 });
              },
              'tools.shout.execute': (args) => `${(args as { text: string }).text.toUpperCase()}!`,
              'tools.explode.execute': () => {
                throw new Error('it exploded');
              },
              'tools.snapshot.execute': () => [
                { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PIXELS } },
              ],
              'tools.add_note.execute': async (args) => {
                noted('add_note', args);
                const { text, ms } = args as { text: string; ms?: number };
                if (ms !== undefined) await pause(ms);
                return `noted: ${text}`;
              },
              'tools.count-stock.execute': async (args) => {
                noted('count-stock', args);
                const { text, ms } = args as { text: string; ms?: number };
                if (ms !== undefined) await pause(ms);
                return JSON.stringify({ item: text, left: text.length });
              },
              'tools.vanish.execute': () => {
                throw new Lost('its process died');
              },
            },
          },
        },
        options: { clock: Date.now, taskTimes: TIMES },
      });
      engines.push(one);
      let actor = of;
      if (actor === undefined) {
        const { agent } = await one.it.deploy({
          agent: 'scripted',
          manifest: MANIFEST,
          code: 'scripted@1',
        });
        actor = (await one.it.createActor({ agent: agent.id })).actor.id;
      }
      const id = actor;
      const lines = async () => (await store.conversation(id)).map(lineOf);
      return {
        one,
        steps,
        script,
        actor: id,
        lines,
        settled: () => one.it.settled(id),
        /** Has the model call `code` once, without waiting for what comes of it. */
        start: async (source: string, more: { [name: string]: Json } = {}) => {
          nextCall += 1;
          script.unshift(
            calls({
              id: `c${String(nextCall)}`,
              name: 'code',
              arguments: { script: source, ...more },
            }),
          );
          await one.say(id, 'go');
        },
        /** Has the model run a script once, and gives what the call was answered with. */
        code: async (source: string, more: { [name: string]: Json } = {}) => {
          nextCall += 1;
          script.push(
            calls({
              id: `c${String(nextCall)}`,
              name: 'code',
              arguments: { script: source, ...more },
            }),
            says('ok'),
          );
          await one.say(id, 'go');
          await one.it.settled(id);
          return (await lines()).findLast((line) => line.startsWith('result')) ?? '';
        },
        tasks: async () =>
          (await store.listTasks(id))
            .map((task) => [task.id, task.kind, task.status, task.stoppedBy])
            .toReversed(),
      };
    };

    beforeEach(async () => {
      store = await open();
      w = world({ store });
      engines = [];
      made = [];
      nextCall = 0;
    });
    afterEach(async () => {
      for (const one of engines) {
        await one.it.close({ graceMs: 50 });
        expect(one.failures).toEqual([]);
      }
      await store.close();
    });

    describe('the code tool', () => {
      it('is offered where the agent has tools for scripts, with what they are', async () => {
        const { one, steps, actor, settled } = await setup();
        await one.say(actor, 'hello');
        await settled();
        const tools = steps[0]?.tools ?? [];
        // The agent's code mode tools are a script's to call, not the model's.
        expect(tools.map((tool) => tool.name)).toEqual(['direct', 'code', 'schedule', 'stop']);
        const told = tools.find((tool) => tool.name === 'code') as unknown as {
          description: string;
          parameters: { properties: object; required: string[] };
        };
        expect(Object.keys(told.parameters.properties)).toEqual(['script', 'wait', 'timeout']);
        expect(told.parameters.required).toEqual(['script']);
        // Its own tools are declared, with their arguments.
        expect(told.description).toContain('declare const tools: {');
        expect(told.description).toMatch(
          /\/\*\* Looks an order up by its ID\. Answers JSON\. \*\/\s+lookup_order\(args: \{\s+id: string;/,
        );
        expect(told.description).toContain('shout(args:');
        expect(told.description).not.toContain('direct(');
        // How a script works is said once, in the instructions, and not here again.
        expect(told.description).not.toMatch(/await sleep|resultOf|console\.log/);
        const instructions = steps[0]?.instructions ?? '';
        expect(instructions).toContain('# Tasks\n\nA script is a task.');
        expect(instructions).toContain('# Scripts\n\n`code` runs JavaScript that calls tools.');
        expect(instructions).toContain(
          '`await resultOf("s3")` gives what an earlier script returned, as data',
        );
        expect(instructions).toContain('`await logsOf("s3")` what it printed');
        // It has no machine: nothing is said of one.
        expect(instructions).toContain('\n\nA script has no files, no shell');
      });

      it('is not offered to an agent with nothing for a script to call, and its model is told nothing of scripts', async () => {
        const steps: ModelStep[] = [];
        const answers: Scripted[] = [
          calls({ id: 'c1', name: 'code', arguments: { script: 'return 1' } }),
          says('oh'),
        ];
        const one = w.engine(
          {
            run: async (step, signal) => {
              steps.push(structuredClone(step));
              const next = answers.shift() ?? says('ok');
              return typeof next === 'function' ? next(step, signal) : next;
            },
          },
          { options: { clock: Date.now, taskTimes: TIMES } },
        );
        engines.push(one);
        const actor = await one.createActor();
        await one.say(actor.id, 'go');
        await one.it.settled(actor.id);
        expect(steps[0]?.tools.map((tool) => tool.name)).toEqual([
          'lookup_order',
          'schedule',
          'stop',
        ]);
        expect((await store.conversation(actor.id)).map(lineOf)[2]).toBe(
          'result (error): There is no tool code',
        );
        // Nothing in what the model is sent speaks of scripts.
        expect(JSON.stringify(steps[0])).not.toMatch(
          /searchTools|ALL_TOOLS|async function|JavaScript|# Scripts/,
        );
      });

      it('leaves a tool of its scripts out of what the model can call itself', async () => {
        const { one, script, actor, lines, settled } = await setup();
        script.push(
          calls({ id: 'c1', name: 'shout', arguments: { text: 'hello' } }),
          calls({ id: 'c2', name: 'direct', arguments: {} }),
          says('ok'),
        );
        await one.say(actor, 'go');
        await settled();
        expect((await lines()).filter((line) => line.startsWith('result'))).toEqual([
          'result (error): There is no tool shout',
          'result: direct',
        ]);
      });
    });

    describe('a script', () => {
      it('is answered with what it returns', async () => {
        const { code, tasks } = await setup();
        expect(await code('return 1 + 1')).toBe('result: 2');
        expect(await code('return "a plain text"')).toBe('result: a plain text');
        expect(await code('return { a: [1, 2], b: null }')).toBe(
          'result: {\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}',
        );
        expect(await code('const x = 1')).toBe('result: (nothing returned)');
        expect(await tasks()).toEqual([
          ['s1', 'code', 'done', null],
          ['s2', 'code', 'done', null],
          ['s3', 'code', 'done', null],
          ['s4', 'code', 'done', null],
        ]);
      });

      it('calls the agent’s own tools, and is given their results parsed', async () => {
        const { code } = await setup();
        expect(
          await code(
            `const order = await tools.lookup_order({ id: "abc" });
             const loud = await tools.shout({ text: "total " + order.total });
             return [order, loud];`,
          ),
        ).toBe(
          `result: ${JSON.stringify([{ id: 'abc', lines: 3, total: 30 }, 'TOTAL 30!'], null, 2)}`,
        );
        // A tool the model calls itself is not one a script can.
        expect(await code('return "direct" in tools')).toBe('result: false');
        expect(await code('return tools.direct({})')).toMatch(
          /^result \(error\): TypeError: tools\.direct does not exist\. Available: lookup_order, shout, explode, /,
        );
        // A name that is no name in JavaScript is one it can say.
        expect(await code('return (await tools.count_stock({ text: "bolt" })).left')).toBe(
          'result: 4',
        );
      });

      it('gives back what it writes with text() before what it returns, and can end early with exit()', async () => {
        const { code } = await setup();
        expect(
          await code('text("first"); text({ a: 1 }); console.log("logged"); return "last";'),
        ).toBe('result: first\n{"a":1}\nlast\n[console]\nlogged');
        expect(await code('text("kept"); exit(); return "never";')).toBe('result: kept');
        expect(
          await code('return ALL_TOOLS.map((tool) => tool.name).includes("lookup_order")'),
        ).toBe('result: true');
      });

      it('shows what it logged after what it returned', async () => {
        const { code } = await setup();
        expect(
          await code('console.log("first", { n: 1 }); console.log("second"); return "done"'),
        ).toBe('result: done\n[console]\nfirst {"n":1}\nsecond');
        expect(await code('console.log("only this")')).toBe('result: [console]\nonly this');
      });

      it('that throws is answered with the error, where it was thrown, and what it had logged', async () => {
        const { code, tasks } = await setup();
        const result = await code(
          'console.log("so far");\nconst list = undefined;\nreturn list.length;',
        );
        expect(result).toMatch(
          /^result \(error\): \[console\]\nso far\nTypeError: cannot read property 'length' of undefined\n\s+at .*codemode\.js:3:\d+\)\n(.*\n)*\[failed\]$/,
        );
        expect(await tasks()).toEqual([['s1', 'code', 'failed', null]]);
      });

      it('is told when a call fails, and can go on', async () => {
        const { code } = await setup();
        expect(
          await code(
            `const tried = [];
             for (const call of [
               () => tools.explode({}),
               () => tools.lookup_order({ id: 7 }),
               () => tools.vanish({}),
               () => tools.shout({ text: "still here" }),
             ]) {
               try { tried.push(await call()); } catch (error) { tried.push(error.message); }
             }
             return tried;`,
          ),
        ).toBe(
          `result: ${JSON.stringify(
            [
              'it exploded',
              'The arguments of lookup_order are not valid: id: Expected a string',
              'The call of vanish was lost: its process died. It may or may not have run.',
              'STILL HERE!',
            ],
            null,
            2,
          )}`,
        );
      });

      it('finds its tools by words, inside itself', async () => {
        const { code } = await setup();
        const result = await code(
          `const found = await searchTools("how many left in stock");
           const one = await searchTools("order note", { limit: 1 });
           return {
             found: found.map((tool) => tool.name),
             first: found[0],
             one: one.length,
             described: await describeTool("add_note"),
             missing: await describeTool("nothing"),
             all: ALL_TOOLS.map((tool) => tool.name),
           };`,
        );
        const value = JSON.parse(result.slice('result: '.length)) as {
          found: string[];
          first: { name: string; description: string; signature: string };
          one: number;
          described: { name: string; signature: string };
          missing: null;
          all: string[];
        };
        expect(value.found).toEqual(['count_stock']);
        // A match says enough to make the call.
        expect(value.first).toEqual({
          name: 'count_stock',
          description: 'How many of an item are left in stock. With `ms`, it takes that long.',
          signature: expect.stringMatching(
            /^count_stock\(args: \{[\s\S]*text: string;[\s\S]*\}\): Promise<unknown>;$/,
          ) as string,
        });
        expect(value.one).toBe(1);
        expect(value.described.name).toBe('add_note');
        expect(value.described.signature).toContain('text: string;');
        expect(value.missing).toBeNull();
        expect(value.all).toEqual([
          'lookup_order',
          'shout',
          'explode',
          'snapshot',
          'add_note',
          'count_stock',
          'vanish',
        ]);
      });

      it('runs the calls it makes together side by side', async () => {
        const { code } = await setup();
        const started = Date.now();
        const result = await code(
          `const items = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
           const all = await Promise.all(items.map((text) => tools.count_stock({ text, ms: 300 })));
           return all.map((one) => one.left).join(",");`,
        );
        expect(result).toBe('result: 1,2,3,4,5,6');
        // One after another they would take 1.8 seconds.
        expect(Date.now() - started).toBeLessThan(1500);
      });

      it('can wait, and has a clock, and nothing else of a computer', async () => {
        const { code } = await setup();
        expect(
          await code(
            'const before = Date.now(); await sleep(0.3); return Date.now() - before >= 300;',
          ),
        ).toBe('result: true');
        // No network, no files, no imports, no timers of its own.
        expect(
          await code(
            'return [typeof fetch, typeof require, typeof process, typeof setTimeout].join()',
          ),
        ).toBe('result: undefined,undefined,undefined,undefined');
      });

      it('starts with nothing of the script before it', async () => {
        const { code } = await setup();
        await code('globalThis.left = 1; return "set"');
        expect(await code('return typeof globalThis.left')).toBe('result: undefined');
      });

      it('that does not parse, or is not a script, is answered at once and is no task', async () => {
        const { code, tasks } = await setup();
        expect(await code('const a = 1;\nreturn a +;')).toBe(
          "result (error): The arguments of code are not valid: the script does not parse: Unexpected token ';', on line 2",
        );
        expect(await code('   ')).toMatch(/script is JavaScript, and is not empty$/);
        expect(await code('return 1', { language: 'js' })).toMatch(/language is not known$/);
        expect(await tasks()).toEqual([]);
      });

      it('is cut in the middle when what it gives back is too long, and says how all of it is read', async () => {
        const { code } = await setup();
        const result = await code('return "start " + "x".repeat(50000) + " end"');
        expect(result.startsWith('result: start xxxx')).toBe(true);
        expect(result.endsWith('xxxx end')).toBe(true);
        // By a script, from what was kept of this one.
        expect(result).toContain(
          '\n[… 30,010 characters left out of the middle. A script can read all of it: resultOf("s1") …]\n',
        );
        expect(result.length).toBeLessThan(20_200);
      });

      it('is stopped at its timeout, and says how far it got', async () => {
        const { code, tasks } = await setup();
        const result = await code(
          `console.log("starting");
           await tools.add_note({ text: "first" });
           await tools.add_note({ text: "second", ms: 5000 });
           return "never";`,
          { timeout: 0.6 },
        );
        expect(result).toMatch(
          /^result: \[console\]\nstarting\n\[stopped part way: 1 of its 2 calls had finished, and 1 were under way and may still be done\]\n\[stopped: timed out after \d+ms\]$/,
        );
        expect(await tasks()).toEqual([['s1', 'code', 'stopped', 'timeout']]);
      });

      it('goes on when its wait runs out, and a notice says what it returned', async () => {
        const { one, script, actor, lines, settled } = await setup();
        script.push(
          calls({
            id: 'c1',
            name: 'code',
            arguments: {
              script: '// count the bolts\nawait sleep(0.5);\nreturn "four bolts";',
              wait: 0.1,
            },
          }),
          says('I will wait.'),
          says('Four.'),
        );
        await one.say(actor, 'go');
        await eventually(async () => (await lines()).length === 6);
        await settled();
        expect((await lines()).slice(2)).toEqual([
          // It has no log to point to: only its ID.
          expect.stringMatching(/^result: moved to the background after \d+ms · task s1$/),
          'assistant: I will wait.',
          expect.stringMatching(
            /^notice: <task id="s1" kind="code" status="done" ran="\d+ms">\n\/\/ count the bolts …\nfour bolts\n<\/task>$/,
          ),
          'assistant: Four.',
        ]);
      });

      it('is stopped by the model, which is told how far it got', async () => {
        const { one, script, actor, lines, settled } = await setup();
        script.push(
          calls({
            id: 'c1',
            name: 'code',
            arguments: {
              script: `await tools.add_note({ text: "one" });
                       console.log("one is written");
                       await sleep(30);
                       await tools.add_note({ text: "two" });`,
              wait: 0,
            },
          }),
          async () => {
            await eventually(() => made.length === 1);
            await pause(100);
            return calls({ id: 'c2', name: 'stop', arguments: { task: 's1' } });
          },
          says('ok'),
        );
        await one.say(actor, 'go');
        await settled();
        expect((await lines()).findLast((line) => line.startsWith('result'))).toMatch(
          /^result: stopped s1 after \d+ms\n\[console\]\none is written\n\[stopped part way: 1 of its 1 calls had finished\]$/,
        );
        expect(made).toEqual(['add_note:one']);
      });
    });

    describe('an image a script shows', () => {
      it('is shown to the model where the script showed it, from a data URL or from a tool', async () => {
        const { code, actor } = await setup();
        const result = await code(
          `text("the shelf:");
           image("data:image/png;base64,${PIXELS}");
           const [shot] = await tools.snapshot({});
           image(shot);
           return "two pictures";`,
        );
        expect(result).toBe('result: the shelf:\n[image]\n[image]\ntwo pictures');
        const message = (await store.conversation(actor)).find(
          (entry) => entry.message.role === 'tool_result',
        )?.message as { content: readonly { type: string; text?: string }[] };
        expect(message.content.map((part) => part.text ?? part.type)).toEqual([
          'the shelf:\n',
          'image',
          '\n',
          'image',
          '\ntwo pictures',
        ]);
        expect(message.content[1]).toEqual({
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: PIXELS },
        });
      });

      it('is one of the first five, and what is left out is said', async () => {
        const { code } = await setup();
        const result = await code(
          `for (let i = 0; i < 7; i += 1) image("data:image/png;base64,${PIXELS}");`,
        );
        expect(result).toBe(
          `result: ${'[image]\n'.repeat(5)}[an image left out: a script shows at most 5]\n[an image left out: a script shows at most 5]`,
        );
      });

      it('is never what a script wrote that looks like the place of one', async () => {
        const { code } = await setup();
        expect(await code('return "a mark: \\uE000"')).toBe('result: a mark: �');
      });
    });

    describe('a script, when the engine stops under it', () => {
      /** The next engine on the store, which goes on with what the first left. */
      const next = async (actor: ActorId) => {
        const second = await setup(actor);
        await second.one.it.recover();
        await second.settled();
        return second;
      };

      it('is run again by the next one, and makes no call twice', async () => {
        const first = await setup();
        await first.start(
          `const first = await tools.add_note({ text: "one" });
           const picked = Math.random();
           await sleep(0.6);
           const second = await tools.add_note({ text: "two" });
           return [first, second, picked === Math.random()];`,
          { wait: 20 },
        );
        await eventually(() => made.length === 1);
        await pause(100);
        await first.one.it.close({ graceMs: 1000 });

        const second = await next(first.actor);
        expect((await second.lines())[2]).toBe(
          'result: [\n  "noted: one",\n  "noted: two",\n  false\n]',
        );
        // The first note was written by the first engine, and not again by the second.
        expect(made).toEqual(['add_note:one', 'add_note:two']);
        expect(await second.tasks()).toEqual([['s1', 'code', 'done', null]]);
      });

      it('has the same clock and the same random numbers when it is run again', async () => {
        const first = await setup();
        await first.start(
          // What it calls with depends on both: run again with others, it would not be the same script.
          `const picked = Math.floor(Math.random() * 1e9);
           const began = Date.now();
           await tools.add_note({ text: picked + " at " + began });
           await sleep(0.5);
           return picked + " at " + began;`,
          { wait: 20 },
        );
        await eventually(() => made.length === 1);
        await pause(100);
        await first.one.it.close({ graceMs: 1000 });

        const second = await next(first.actor);
        expect(made).toHaveLength(1);
        expect((await second.lines())[2]).toBe(
          `result: ${made[0]?.slice('add_note:'.length) ?? ''}`,
        );
      });

      it('is told that a call was cut off, when the call is not safe to make again', async () => {
        const first = await setup();
        await first.start(
          `try {
             return await tools.add_note({ text: "one", ms: 1500 });
           } catch (error) {
             return "told: " + error.message;
           }`,
          { wait: 20 },
        );
        await eventually(() => made.length === 1);
        await first.one.it.close({ graceMs: 1000 });

        const second = await next(first.actor);
        expect((await second.lines())[2]).toBe(
          'result: told: The call of add_note was cut off when the engine stopped. It may or may not have run.',
        );
        expect(made).toEqual(['add_note:one']);
      });

      it('makes a call again that was cut off, when the call is safe to', async () => {
        const first = await setup();
        await first.start('return (await tools.count_stock({ text: "bolt", ms: 800 })).left;', {
          wait: 20,
        });
        await eventually(() => made.length === 1);
        await first.one.it.close({ graceMs: 1000 });

        const second = await next(first.actor);
        expect((await second.lines())[2]).toBe('result: 4');
        expect(made).toEqual(['count-stock:bolt', 'count-stock:bolt']);
      });

      it('does not wait again for what it had waited for', async () => {
        const first = await setup();
        await first.start('await sleep(0.2); await sleep(1); return "rested";', { wait: 20 });
        await pause(700);
        await first.one.it.close({ graceMs: 1000 });

        const started = Date.now();
        const second = await next(first.actor);
        expect((await second.lines())[2]).toBe('result: rested');
        // About half a second was left of the second wait, and none of the first.
        expect(Date.now() - started).toBeLessThan(1000);
      });

      it('fails, and says so, when it is no longer the script it was', async () => {
        const first = await setup();
        await first.start(
          'await tools.add_note({ text: "one" }); await sleep(0.5); return "done";',
          { wait: 20 },
        );
        await eventually(() => made.length === 1);
        await pause(100);
        await first.one.it.close({ graceMs: 1000 });
        const [call] = await store.listScriptCalls(first.actor, 's1');
        expect(call).toMatchObject({ id: 1, name: 'add_note', retrySafe: false });
        // What the next engine finds stored of its first call is of another call.
        const changed = over(store, {
          listScriptCalls: async (actor, task) =>
            (await store.listScriptCalls(actor, task)).map((one) => ({ ...one, name: 'shout' })),
        });
        const second = await setup(first.actor, world({ store: changed }));
        await second.one.it.recover();
        await second.settled();
        expect((await second.lines())[2]).toBe(
          'result (error): The script could not be continued after the engine restarted: its call number 1 was shout before, and is add_note now. Some of its calls were made: check before running it again.\n[failed]',
        );
        expect(await second.tasks()).toEqual([['s1', 'code', 'failed', null]]);
      });
    });

    describe('what a script came to', () => {
      /** A script that returns three thousand rows, far more than it is shown of. */
      const ROWS = `const rows = [];
for (let i = 0; i < 3000; i += 1) rows.push({ id: i, failed: i % 7 === 0, note: "x".repeat(20) });
console.log("made", rows.length);
return rows;`;
      /** Has a script say what a call of it fails with. */
      const failing = (call: string): string =>
        `try { await ${call}; return "it did not fail"; } catch (error) { return error.message; }`;

      it('is kept whole, and a later script reads what it returned as the data it was', async () => {
        const { code } = await setup();
        const shown = await code(ROWS);
        expect(shown).toContain(
          'A script can read all of it: resultOf("s1") for what it returned, logsOf("s1") for the rest',
        );
        expect(
          await code(
            `const rows = await resultOf("s1");
             return [rows.length, rows.filter((row) => row.failed).length, rows[2999].id];`,
          ),
        ).toBe('result: [\n  3000,\n  429,\n  2999\n]');
        expect(await code('return await logsOf("s1")')).toBe('result: made 3000');
      });

      it('is what a script printed and how it failed, for one that returned nothing', async () => {
        const { code } = await setup();
        await code('console.log("so far"); throw new Error("no");');
        expect(await code(failing('resultOf("s1")'))).toBe(
          'result: The script s1 failed, so it returned nothing. What it printed, and how it ended: logsOf("s1")',
        );
        expect(await code('return await logsOf("s1")')).toMatch(
          /^result: so far\nError: no\n(.*\n)*\[failed\]$/,
        );
      });

      it('is what it printed and how far it got, for one that was stopped', async () => {
        const { code } = await setup();
        await code(
          'console.log("begun"); await tools.add_note({ text: "one" }); await sleep(30);',
          {
            timeout: 0.5,
          },
        );
        expect(await code(failing('resultOf("s1")'))).toBe(
          'result: The script s1 was stopped, so it returned nothing. What it printed, and how it ended: logsOf("s1")',
        );
        // Its own waiting is not one of its calls.
        expect(await code('return await logsOf("s1")')).toBe(
          'result: begun\n[stopped part way: 1 of its 1 calls had finished]',
        );
      });

      it('is nothing for a script that returned nothing, and that is what is read', async () => {
        const { code } = await setup();
        await code('const x = 1');
        expect(await code('return [await resultOf("s1"), await logsOf("s1")]')).toBe(
          'result: [\n  null,\n  ""\n]',
        );
      });

      it('is read only of a script, of one’s own, that has ended', async () => {
        const { one, script, actor, code, settled } = await setup();
        script.push(
          calls({ id: 'n1', name: 'schedule', arguments: { note: 'Later.', in: 3600 } }),
          says('ok'),
        );
        await one.say(actor, 'go');
        await settled();
        expect(await code(failing('resultOf()'))).toBe(
          'result: resultOf takes the ID of a script, such as "s3"',
        );
        expect(await code(failing('logsOf(3)'))).toBe(
          'result: logsOf takes the ID of a script, such as "s3"',
        );
        expect(await code(failing('resultOf("s3")'))).toBe('result: s3 is this script');
        expect(await code(failing('resultOf("s9")'))).toBe('result: You have no script s9');
        expect(await code(failing('resultOf("t1")'))).toBe(
          'result: t1 is not a script: it is a schedule task',
        );
        // Of another actor, there is none of that ID.
        const other = (await one.it.createActor({ agent: (await one.it.getActor(actor)).agent }))
          .actor.id;
        script.push(
          calls({
            id: 'o1',
            name: 'code',
            arguments: { script: failing('resultOf("s2")') },
          }),
          says('ok'),
        );
        await one.say(other, 'go');
        await one.it.settled(other);
        expect(
          (await store.conversation(other)).map(lineOf).find((line) => line.startsWith('result')),
        ).toBe('result: You have no script s2');
      });

      it('cannot be read while the script runs, and can once it has ended', async () => {
        const { one, script, actor, lines, code } = await setup();
        script.push(
          calls({
            id: 'c0',
            name: 'code',
            arguments: { script: 'await sleep(0.8); return "slept";', wait: 0 },
          }),
          says('ok'),
        );
        await one.say(actor, 'go');
        await one.it.settled(actor);
        expect(await code(failing('resultOf("s1")'))).toBe(
          'result: The script s1 is still running: it can be read once it has ended',
        );
        await eventually(async () => (await lines()).some((line) => line.startsWith('notice:')));
        await one.it.settled(actor);
        expect(await code('return await resultOf("s1")')).toBe('result: slept');
      });

      it('is read the same by a script that the next engine runs again', async () => {
        const first = await setup();
        await first.code('return { rows: [1, 2, 3] }');
        await first.start(
          `const before = await resultOf("s1");
           await sleep(0.6);
           return [before, await resultOf("s1")];`,
          { wait: 20 },
        );
        await pause(300);
        await first.one.it.close({ graceMs: 1000 });
        // What it read is not stored a second time: only which script it read.
        const [read] = await store.listScriptCalls(first.actor, 's2');
        expect(read).toMatchObject({
          name: 'resultOf',
          done: { outcome: { ok: true, from: 's1' } },
        });

        const second = await setup(first.actor);
        await second.one.it.recover();
        await second.settled();
        const both = { rows: [1, 2, 3] };
        expect((await second.lines()).findLast((line) => line.startsWith('result'))).toBe(
          `result: ${JSON.stringify([both, both], null, 2)}`,
        );
      });
    });
  });
}
