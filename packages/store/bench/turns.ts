// How fast the engine turns, on a database on disk, with a model that answers at once: so what
// is measured is the engine and the store, and nothing of any provider.
//
// Every actor is sent a message at the same moment, and takes a turn of two calls of the model
// and one of a tool. That is done a number of times. It is run once with writes that come
// together sharing a transaction, and once with each write alone, to see what the sharing saves.
//
//   pnpm bench [--actors 200] [--turns 5] [--full-fsync]
//
// On macOS a commit does not wait for the disk itself unless `--full-fsync` is given, so without
// it the numbers there are kinder than a server's, where it always waits.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { echoRunner } from '@acentric/ai/testing';
import { Engine } from '@acentric/core';
import { InlineExecutor } from '@acentric/core/testing';
import { makeId } from '@acentric/protocol';
import type { AgentDefinition } from '@acentric/protocol';

import { SqliteStore } from '../src/index.ts';

const args = process.argv.slice(2);
const numberOf = (name: string, otherwise: number): number => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? otherwise : Number(args[at + 1]);
};
const ACTORS = numberOf('actors', 200);
const TURNS = numberOf('turns', 5);
const FULL_FSYNC = args.includes('--full-fsync');

const FIXED = { now: 1_795_305_600_000, random: new Uint8Array(10).fill(7) };
const agent = makeId('agent', FIXED);
const deployment = { id: makeId('deployment', FIXED), version: 1 };
const definition: AgentDefinition = {
  provider: 'fake',
  instructions: 'You look things up.',
  configuration: null,
  tools: [
    {
      name: 'lookup',
      description: 'Looks it up.',
      parameters: { type: 'object' },
      retrySafe: true,
    },
  ],
  inputs: [{ type: 'message', schema: null }],
};

async function run(groupCommit: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'acentric-bench-'));
  const store = await SqliteStore.open(join(dir, 'bench.sqlite'), {
    groupCommit,
    fullFsync: FULL_FSYNC,
  });
  const executor = new InlineExecutor(
    new Map([
      [
        deployment.id,
        {
          definition,
          functions: {
            'inputs.message.handler': (payload) => (payload as { text: string }).text,
            'tools.lookup.execute': (asked) => `looked up ${JSON.stringify(asked)}`,
          },
        },
      ],
    ]),
  );
  const engine = new Engine({
    store,
    runner: echoRunner('lookup'),
    executor,
    maxConcurrentTurns: ACTORS,
  });
  const actors = await Promise.all(
    Array.from({ length: ACTORS }, () =>
      engine.createActor({ agent, deployment, modelId: 'fake-1' }),
    ),
  );
  const before = await store.stats();

  const started = performance.now();
  for (let turn = 0; turn < TURNS; turn += 1) {
    await Promise.all(
      actors.map(({ actor }) =>
        engine.send(actor.id, { type: 'message', payload: { text: `message ${String(turn)}` } }),
      ),
    );
    await engine.settled();
  }
  const ms = performance.now() - started;

  const after = await store.stats();
  await engine.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });

  const turns = ACTORS * TURNS;
  const writes = after.writes - before.writes;
  const transactions = after.transactions - before.transactions;
  return {
    'writes share a transaction': groupCommit ? 'yes' : 'no',
    turns,
    seconds: (ms / 1000).toFixed(2),
    'turns per second': Math.round(turns / (ms / 1000)),
    // A turn here is two calls of the model.
    'ms per call of the model': (ms / (turns * 2)).toFixed(2),
    writes,
    transactions,
    'writes per transaction': (writes / transactions).toFixed(1),
  };
}

console.log(
  `${String(ACTORS)} actors, ${String(TURNS)} turns each, all at once${FULL_FSYNC ? ', each commit waiting for the disk itself' : ''}.`,
);
console.table([await run(true), await run(false)]);
