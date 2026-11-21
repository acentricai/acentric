// A process for the crash tests to kill. It runs an engine on a database on disk through two
// turns of one actor, and, when told to, kills itself at a named point with no warning, as a
// crash or a pulled plug does. Run again on the same database, it picks up what is owed and
// goes on, and says how things stand at the end.
//
// Nothing in the engine or the store knows of this: the points are reached by wrapping the
// parts the engine is given.
//
//   node crash-host.ts --db <file> --ledger <file> [--crash <point>] [--retry-safe]
//
//   before-commit:N   as the engine's Nth commit is about to be stored
//   after-commit:N    once the Nth commit is stored, before the engine is told
//   after-input:N     once the Nth input is in the mailbox, before the engine is told
//   in-model:N        while the Nth call of the model is under way
//   in-tool:N         while the Nth call of the tool is under way, after it has done its work

import { appendFileSync } from 'node:fs';

import type { ModelRunner } from '@acentric/ai';
import { echoRunner } from '@acentric/ai/testing';
import { Engine } from '@acentric/core';
import type { Store } from '@acentric/core';
import { InlineExecutor } from '@acentric/core/testing';
import { makeId } from '@acentric/protocol';
import type { AgentDefinition, ToolResultMessage } from '@acentric/protocol';

import { SqliteStore } from '../src/index.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const db = option('db');
const ledger = option('ledger');
if (db === undefined || ledger === undefined) throw new Error('--db and --ledger are needed');
const retrySafe = args.includes('--retry-safe');
const [where, nth] = (option('crash') ?? 'none:0').split(':') as [string, string];

/** Counts the times each kind of point is passed, and ends the process at the one named. */
const passed = new Map<string, number>();
function point(kind: string): void {
  const count = (passed.get(kind) ?? 0) + 1;
  passed.set(kind, count);
  if (kind === where && count === Number(nth)) process.kill(process.pid, 'SIGKILL');
}

// The same in every run: the agent is found again by what it was called.
const FIXED = { now: 1_795_305_600_000, random: new Uint8Array(10).fill(7) };
const agent = makeId('agent', FIXED);
const deployment = { id: makeId('deployment', FIXED), version: 1 };
const definition: AgentDefinition = {
  provider: 'fake',
  instructions: 'You look things up.',
  configuration: null,
  tools: [
    { name: 'lookup', description: 'Looks it up.', parameters: { type: 'object' }, retrySafe },
  ],
  inputs: [{ type: 'message', schema: null }],
};

const real = await SqliteStore.open(db);
const store: Store = {
  createActor: (actor) => real.createActor(actor),
  loadActor: (id) => real.loadActor(id),
  commit: async (id, epoch, change) => {
    point('before-commit');
    await real.commit(id, epoch, change);
    point('after-commit');
  },
  addInput: async (input) => {
    const status = await real.addInput(input);
    if (status === 'accepted') point('after-input');
    return status;
  },
  findInput: (actor, externalId) => real.findInput(actor, externalId),
  pendingInputs: (actor) => real.pendingInputs(actor),
  conversation: (actor, part) => real.conversation(actor, part),
  unfinished: () => real.unfinished(),
  close: () => real.close(),
};

const echo = echoRunner('lookup');
const runner: ModelRunner = {
  run: (step, signal) => {
    point('in-model');
    return echo.run(step, signal);
  },
};

const executor = new InlineExecutor(
  new Map([
    [
      deployment.id,
      {
        definition,
        functions: {
          'inputs.message.handler': (payload) => (payload as { text: string }).text,
          'tools.lookup.execute': (asked) => {
            // What the tool does outside the engine: written down before anything can stop it.
            appendFileSync(ledger, `${JSON.stringify(asked)}\n`);
            point('in-tool');
            return `looked up ${JSON.stringify(asked)}`;
          },
        },
      },
    ],
  ]),
);

const engine = new Engine({ store, runner, executor });
const { actor } = await engine.createActor({
  agent,
  deployment,
  model: 'fake-1',
  externalId: 'the-one-actor',
});

const recovered = await engine.recover();
for (const text of ['first', 'second']) {
  await engine.send(actor.id, { type: 'message', payload: { text }, externalId: text });
  await engine.settled();
}

const record = await real.loadActor(actor.id);
const conversation = await real.conversation(actor.id);
console.log(
  JSON.stringify({
    recovered,
    status: record?.actor.status,
    lastTurn: record?.actor.lastTurn?.end,
    turn: record?.turn.phase,
    seqs: conversation.map((entry) => entry.seq),
    roles: conversation.map((entry) => entry.message.role),
    results: conversation
      .filter((entry) => entry.message.role === 'tool_result')
      .map((entry) => {
        const message = entry.message as ToolResultMessage;
        return { call: message.toolCallId, isError: message.isError === true };
      }),
  }),
);
await engine.close();
await real.close();
process.exit(0);
