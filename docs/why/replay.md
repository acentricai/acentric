# Replaying a session

_Re-run what a session received, and get the same results._

**The claim:** a session is its first state plus the messages it received,
with the time of each. Delivering the same messages again gives the same states
and the same log, every time, with no model, network or handler running.

That makes a session reproducible. A bug seen in production replays on your
laptop, step by step. New code can be replayed over old sessions, to see what
it would have done differently before it is deployed.

## In a loop

A loop's run depends on everything it awaited: each model reply, each tool
result, and when each input arrived. Reproducing one means recording all of
that, usually by intercepting its network calls, then running the loop again
against the recording, with the same timing. If the code has changed, the new
loop may make different calls, and the recording no longer fits.

## As a reducer

Everything an agent learns from the world reaches `step` as a message. A
model's reply is an `effect` message; so is a tool's result and a timer firing.
So the messages a session received are the whole of its input, and `step` is a
pure function of them. Replaying is delivering them again, in order, each at
its time. No handler runs, so nothing is sent twice: the model's replies are in
the messages.

This agent lets a user send at most 3 messages a minute. It has a bug: it
checks with `>` where it should use `>=`, so a fourth message gets through.

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent } from '@acentric/types';

type Snapshot = { recent: number[] };

const agent: Agent<Snapshot> = {
  name: 'limiter',
  version: '0.1.0',

  init: () => ({ snapshot: { recent: [] } }),

  step: ({ snapshot }, message, now) => {
    if (message.type !== 'input') return { snapshot };
    const recent = snapshot.recent.filter((at) => now - at < 60_000);
    if (recent.length > 3)
      return { snapshot, append: [{ kind: 'limited', body: null }] };
    return {
      snapshot: { recent: [...recent, now] },
      append: [{ kind: 'accepted', body: message.payload }],
    };
  },
};

export default agent;
```

The fix changes one comparison:

`src/fixed.ts`:

```ts title="src/fixed.ts"
import type { Agent } from '@acentric/types';

import agent from './agent.js';

type Snapshot = { recent: number[] };

const fixed: Agent<Snapshot> = {
  ...agent,
  version: '0.1.1',
  step: ({ snapshot }, message, now) => {
    if (message.type !== 'input') return { snapshot };
    const recent = snapshot.recent.filter((at) => now - at < 60_000);
    if (recent.length >= 3)
      return { snapshot, append: [{ kind: 'limited', body: null }] };
    return {
      snapshot: { recent: [...recent, now] },
      append: [{ kind: 'accepted', body: message.payload }],
    };
  },
};

export default fixed;
```

A runner that keeps a journal records each message it delivers, with its time,
the version that handled it, and a digest of what the step left. This runs the
agent on the memory runner, which keeps one, then replays the journal: first on
the code that ran it, then on the fix.

`replay.ts`:

```ts title="replay.ts" run
import assert from 'node:assert/strict';

import { createMemoryRunner } from '@acentric/runner-memory';
import { forReplay, replay } from '@acentric/replay';

import agent from './src/agent.js';
import fixed from './src/fixed.js';

// A session that sends five messages, four of them in its first minute.
let time = 0;
const runner = createMemoryRunner({ clock: () => time });
const { id } = runner.create(runner.load(agent), {});
if (id === undefined) throw new Error('the session was not created');
for (const at of [0, 10_000, 20_000, 30_000, 70_000]) {
  time = at;
  await runner.input(id, 'say', { at });
}
const journal = [...runner.journal(id)];

// On the code that ran it, every entry gives what the journal recorded.
assert.equal(replay(journal, forReplay(agent)).differs, null);

// On the fix, the same session differs at its fourth message: entry 5,
// since entry 1 is the session's creation.
const whatIf = replay(journal, forReplay(fixed), { mode: 'what-if' });
assert.equal(whatIf.differs, 5);
assert.deepEqual(
  whatIf.simulation.log.map((entry) => entry.kind),
  ['accepted', 'accepted', 'accepted', 'limited', 'accepted'],
);
runner.close();
```

No model, network or handler ran in either replay.

## On a runner

The memory and local runners keep a journal for every session. On the local
runner, `acentric replay` replays a session on the code that ran it, each entry
on its own version, and says whether every entry gave what was recorded:

```sh
acentric replay 3f2a91c4-0d7e-4b8a-9c51-6e2d8f0b7a13
```

```text
replayed 128 entries: each gave what the journal recorded
```

With `--what-if`, it builds the project's code instead and replays the session
on it from the start, listing the entries that would differ:

```sh
acentric replay 3f2a91c4-0d7e-4b8a-9c51-6e2d8f0b7a13 --what-if
```

```text
replayed 128 entries on limiter@0.1.1: 3 would differ, the first at entry 5
  #5 input say: expected accepted 9b2f41c07d3e, got accepted 51aa0e86c2f9
  ...
```

The same journal lets a session be forked: `acentric fork <id> --at 40` makes a
new session with the state the original had after entry 40, which then goes its
own way. Effects that had finished stay finished, and those that were running
start again, as after a crash.

## The proof

- **The example above runs in our docs check,** on the memory runner's real
  journal.
- **The conformance scenarios replay every session.** For a runner that keeps
  a journal, the conformance player replays it after every action of every
  scenario, and each entry must give the answer and digest it recorded. The
  memory runner and the local runner, over SQLite, plain files and the
  protocol, pass them all, along with scenarios for forks.
- **The CLI is tested on a running runner:** a faithful replay, a what-if
  replay that finds the entry changed code would alter, and a fork.
