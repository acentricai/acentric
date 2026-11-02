# Effects you can see and cancel

_What should be running follows from the state, and cancelling is not declaring._

**The claim:** what an agent has running is a function of its state, so it can
be read at any moment. Cancelling one piece of work is changing the state so it
is no longer declared.

## In a loop

A research loop searches several sources at once:

```ts
async function research(queries: string[]) {
  const results = await Promise.all(queries.map((query) => search(query)));
  return summarise(results);
}
```

Now the user drops one query while the searches run, or cancels them all.

- **What is running?** The answer is a set of pending promises inside a paused
  call. To list them, the loop must keep its own map of what it started, and
  keep it up to date.
- **Dropping one search** needs an `AbortController` per query, passed into
  every call that does I/O, and code that ignores a result that arrives just
  after its query was dropped.
- **`Promise.all`** rejects on the first abort, so dropping one query fails
  them all unless every search catches its own.

Each of these is code around the loop, written by hand, and easy to get subtly
wrong.

## As a reducer

The agent keeps the searches it wants in its snapshot. `effects` turns them
into requests, and the runner keeps what is running in line with that list:

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent, NoConfig } from '@acentric/types';

type Search = { key: string; query: string };
type Snapshot = { searches: Search[]; started: number };

export type ResearchKinds = {
  search: { args: { query: string }; result: { hits: string[] } };
};

const agent: Agent<Snapshot, NoConfig, ResearchKinds> = {
  name: 'research',
  version: '0.1.0',
  kinds: ['search'],

  init: () => ({ snapshot: { searches: [], started: 0 } }),

  step: ({ snapshot }, message) => {
    const { searches, started } = snapshot;
    if (message.type === 'input' && message.kind === 'search') {
      const queries = message.payload['queries'];
      if (!Array.isArray(queries)) return { error: 'search needs queries' };
      const added = queries.map((query, i) => ({
        key: `search:${started + i + 1}`,
        query: String(query),
      }));
      return {
        snapshot: {
          searches: [...searches, ...added],
          started: started + added.length,
        },
      };
    }
    if (message.type === 'input' && message.kind === 'drop') {
      const query = message.payload['query'];
      return {
        snapshot: { ...snapshot, searches: searches.filter((s) => s.query !== query) },
      };
    }
    if (message.type === 'input' && message.kind === 'cancel') {
      return { snapshot: { ...snapshot, searches: [] } };
    }
    if (message.type !== 'effect') return { snapshot };
    const search = searches.find((s) => s.key === message.key);
    const rest = searches.filter((s) => s.key !== message.key);
    const hits = 'ok' in message.outcome ? message.outcome.ok.hits : [];
    return {
      snapshot: { ...snapshot, searches: rest },
      append: [{ kind: 'hits', body: { query: search?.query ?? null, hits } }],
    };
  },

  effects: ({ snapshot }) =>
    snapshot.searches.map(({ key, query }) => ({
      key,
      kind: 'search',
      args: { query },
    })),
};

export default agent;
```

There is no cancellation code. Dropping a query removes it from the snapshot,
so `effects` no longer declares its search, and the runner cancels it: its
handler's signal fires, and its result is never delivered, even if it was
already on its way. Cancelling all of them is an empty list.

What is running is `effects(state)`, so any state can be asked, not only the
live one:

`test/agent.test.ts`:

```ts title="test/agent.test.ts" run
import assert from 'node:assert/strict';

import { simulate } from '@acentric/testing';

import agent from '../src/agent.js';

const research = simulate(agent, {});
research.input('search', { queries: ['rome', 'paris', 'oslo'] });

// What should be running, read straight from the state.
const declared = agent.effects?.(research.state()) ?? [];
assert.deepEqual(
  declared.map((effect) => effect.args.query),
  ['rome', 'paris', 'oslo'],
);

// Dropping a query cancels its search, and only its search.
assert.deepEqual(research.input('drop', { query: 'paris' }).cancelled, ['search:2']);
// A cancelled search has nothing left to report.
assert.throws(() => research.ok('search:2', { hits: ['Louvre'] }));

research.ok('search:1', { hits: ['Colosseum'] });
assert.deepEqual(research.input('cancel', {}).cancelled, ['search:3']);
assert.deepEqual(research.running, []);
assert.deepEqual(
  research.log.map((entry) => entry.body),
  [{ query: 'rome', hits: ['Colosseum'] }],
);
```

To stop an effect but keep what it has so far, such as half a model reply, the
agent keeps its key and marks it `abort: true`. Its handler's signal fires, and
what it returns is still delivered. See
[Effects and handlers](../concepts/effects.md#cancelling-and-aborting).

Outside a test, the same list is what a runner shows. `acentric get <id>` lists
a session's running effects with their kinds and args, and the dev UI shows
them live.

## The proof

- **The test above runs in our docs check.**
- **The conformance scenarios check it on every runner:** a new key starts an
  effect; a dropped key is cancelled and never reports; a key marked `abort`
  stops and still reports; a finished key never runs again; a running key's
  args are not changed; and a cancel survives a crash.
