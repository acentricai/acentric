# Same agent, any runner

_One bundle runs unchanged on every runner that passes the same tests._

**The claim:** one agent runs unchanged on every runner. Moving it from a test,
to your laptop, to a fleet of servers changes the runner, not the agent.

## In a loop

A loop is written against the place it runs. It keeps its conversation where
its framework or its author chose: a checkpointer, a database table, a variable.
Its timers are the process's timers, and its calls in flight live in the
process's memory. So its host decides what it can do:

- On a server, it can wait a week for a reply, until the server restarts.
- In a serverless function, it cannot wait at all past the function's time
  limit.
- In a durable workflow engine, it has to be written in that engine's style, to
  that engine's rules.

Moving a loop from one host to another means rewriting the parts that touch the
host, and often the shape of the loop itself.

## As a reducer

An agent touches nothing outside its arguments. `step` gets a state, a message
and a time, and returns a state; handlers get args and a context. Where state
is kept, how a timer waits, and how many processes there are all belong to the
runner, and every runner follows one contract. An agent ships as two ES
modules, the agent and its handlers, and those two files are what every runner
loads.

Here is an agent with a handler of its own:

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent, NoConfig } from '@acentric/types';

type Snapshot = { pending: { key: string; text: string }[]; said: number };

export type ShoutKinds = { shout: { args: { text: string }; result: string } };

const agent: Agent<Snapshot, NoConfig, ShoutKinds> = {
  name: 'shouter',
  version: '0.1.0',
  kinds: ['shout'],

  init: () => ({ snapshot: { pending: [], said: 0 } }),

  step: ({ snapshot }, message) => {
    if (message.type === 'input' && message.kind === 'say') {
      const text = String(message.payload['text']);
      const pending = [...snapshot.pending, { key: `shout:${message.id}`, text }];
      return { snapshot: { pending, said: snapshot.said + 1 } };
    }
    if (message.type !== 'effect') return { snapshot };
    const pending = snapshot.pending.filter((p) => p.key !== message.key);
    const shouted = 'ok' in message.outcome ? message.outcome.ok : null;
    return {
      snapshot: { ...snapshot, pending },
      append: [{ kind: 'shouted', body: shouted }],
    };
  },

  effects: ({ snapshot }) =>
    snapshot.pending.map(({ key, text }) => ({ key, kind: 'shout', args: { text } })),

  view: ({ snapshot }) => ({ said: snapshot.said }),
};

export default agent;
```

`src/handlers.ts`:

```ts title="src/handlers.ts"
import type { HandlersFor } from '@acentric/types';

import type { ShoutKinds } from './agent.js';

const handlers: HandlersFor<ShoutKinds> = {
  shout: { mode: 'reissue', run: async ({ args }) => args.text.toUpperCase() },
};

export default handlers;
```

This runs the agent on two runners that share no code: the memory runner, given
the agent as an object, and the local runner, given the same two modules as
files, keeping the session in SQLite and running the handler in a child
process. The same inputs give the same log and the same view:

`portable.ts`:

```ts title="portable.ts" run
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createLocalRunner, openSqliteStore } from '@acentric/runner-local';
import { createMemoryRunner } from '@acentric/runner-memory';

import agent from './src/agent.js';
import handlers from './src/handlers.js';

const said = [
  { id: 'a', text: 'hello' },
  { id: 'b', text: 'goodbye' },
];

/** Waits until `done` is true. */
async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; !(await done()); tries += 1) {
    if (tries === 500) throw new Error('timed out');
    await sleep(10);
  }
}

// The memory runner, given the agent as an object.
const memory = createMemoryRunner();
const m = memory.create(memory.load(agent, handlers), {}).id ?? '';
for (const [i, { id, text }] of said.entries()) {
  await memory.input(m, 'say', { text }, id);
  await until(() => memory.log(m).length === i + 1);
}
const onMemory = {
  log: memory.log(m).map(({ kind, body }) => ({ kind, body })),
  view: memory.view(m),
};
memory.close();

// The local runner, given the same modules as files.
const dir = await mkdtemp(join(tmpdir(), 'acentric-'));
const store = await openSqliteStore(join(dir, 'agents.db'));
const local = createLocalRunner({ store, codeDir: join(dir, 'code') });
await local.start();
const ref = { name: agent.name, version: agent.version };
await local.deploy({
  ...ref,
  agent: await readFile(new URL('./src/agent.js', import.meta.url), 'utf8'),
  handlers: await readFile(new URL('./src/handlers.js', import.meta.url), 'utf8'),
});
const l = (await local.create(ref, {})).id ?? '';
for (const [i, { id, text }] of said.entries()) {
  await local.input(l, { id, kind: 'say', payload: { text } });
  await until(async () => (await local.log(l)).entries.length === i + 1);
}
const onLocal = {
  log: (await local.log(l)).entries.map(({ kind, body }) => ({ kind, body })),
  view: (await local.get(l)).view,
};
await local.close();
await store.close();
await rm(dir, { recursive: true, force: true });

assert.deepEqual(onMemory, {
  log: [
    { kind: 'shouted', body: 'HELLO' },
    { kind: 'shouted', body: 'GOODBYE' },
  ],
  view: { said: 2 },
});
assert.deepEqual(onLocal, onMemory);
```

## The proof

- **The example above runs in our docs check,** on both runners.
- **One test agent, the probe, passes every conformance scenario in five
  setups:** the memory runner; the local runner over SQLite and over plain
  files; and the local runner in its own process, reached through its protocol,
  over each store. Crashes and upgrades included.
- **Anyone can add a runner.** [Writing your own](../concepts/runners.md#writing-your-own)
  explains how the same scenarios check a new one, in any language.
