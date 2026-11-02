# One message at a time

_A stop or a steer that arrives mid-reply is just the next message._

**The claim:** a stop, a steer or a config change that arrives while a model is
replying is just the next message. A session takes its messages one at a time,
so there is nothing to race and nothing to lock.

## In a loop

A chat loop that can be stopped, and steered while it replies, needs state
shared between the loop and whatever receives the user's input:

```ts
let stop = false;
const steers: string[] = [];
const controller = new AbortController();

onInput((input) => {
  if (input.kind === 'stop') {
    stop = true;
    controller.abort();
  }
  if (input.kind === 'steer') steers.push(input.text);
});

async function chat(messages: Message[]) {
  while (true) {
    const reply = await model(messages, { signal: controller.signal });
    messages.push(reply);
    if (stop || steers.length === 0) return reply;
    messages.push(...steers.splice(0).map(asUserMessage));
  }
}
```

Each input lands at whatever point the loop is paused in, and each point is a
case to get right:

- A stop that arrives just after the reply finished leaves `stop` set, so the
  next conversation stops after its first reply. Resetting it when `chat`
  starts loses a stop that arrives just before.
- An aborted `model` call throws, so the half-written reply is lost unless every
  `await` catches it. The aborted controller must be replaced before the next
  call.
- A second message while the first is being answered starts a second loop that
  shares the same flags.

Which case happens depends on timing, so a test cannot choose it, and a bug in
one shows up only now and then.

## As a reducer

The runner queues a session's messages and gives `step` one at a time. A stop
is a message; so is the reply arriving. Whichever comes first, `step` sees a
state that says what is happening, and each case is a branch:

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent, NoConfig } from '@acentric/types';

type Reply = { key: string; steers: string[]; stop: boolean };
type Snapshot = { replying: Reply | null; queued: string[]; turn: number };

export type ChatKinds = {
  reply: { args: { steers: string[] }; result: { text: string } };
};

const agent: Agent<Snapshot, NoConfig, ChatKinds> = {
  name: 'chat',
  version: '0.1.0',
  kinds: ['reply'],

  init: () => ({ snapshot: { replying: null, queued: [], turn: 0 } }),

  step: ({ snapshot }, message) => {
    const { replying, queued, turn } = snapshot;
    const start = (steers: string[]): Snapshot => ({
      replying: { key: `reply:${turn + 1}`, steers, stop: false },
      queued: [],
      turn: turn + 1,
    });
    if (message.type === 'input') {
      const text = String(message.payload['text'] ?? '');
      switch (message.kind) {
        case 'say':
          if (replying !== null) return { error: 'still replying' };
          return { snapshot: start([]), append: [{ kind: 'user', body: text }] };
        case 'steer':
          if (replying === null) return { error: 'nothing to steer' };
          return { snapshot: { ...snapshot, queued: [...queued, text] } };
        case 'stop':
          if (replying === null) return { error: 'nothing to stop' };
          return {
            snapshot: {
              ...snapshot,
              replying: { ...replying, stop: true },
              queued: [],
            },
          };
        default:
          return { error: `unknown input ${message.kind}` };
      }
    }
    if (message.type !== 'effect' || replying === null) return { snapshot };
    const reply = 'ok' in message.outcome ? message.outcome.ok.text : '';
    const append = [
      { kind: 'assistant', body: { text: reply, stopped: replying.stop } },
    ];
    // Steering that arrived during the reply goes to the next one.
    if (!replying.stop && queued.length > 0) return { snapshot: start(queued), append };
    return { snapshot: { ...snapshot, replying: null }, append };
  },

  effects: ({ snapshot }) => {
    const { replying } = snapshot;
    if (replying === null) return [];
    const { key, steers, stop } = replying;
    return [{ key, kind: 'reply', args: { steers }, abort: stop }];
  },
};

export default agent;
```

A stop before the reply finishes aborts it and keeps what was written. A stop
after it finishes is refused, because there is nothing left to stop. Both
orders can be tested, each exactly, because a test chooses the order of the
messages:

`test/agent.test.ts`:

```ts title="test/agent.test.ts" run
import assert from 'node:assert/strict';

import { simulate } from '@acentric/testing';

import agent from '../src/agent.js';

// The stop arrives while the reply is being written.
const early = simulate(agent, {});
early.input('say', { text: 'tell me about Rome' });
assert.deepEqual(early.input('stop', {}).aborted, ['reply:1']);
early.ok('reply:1', { text: 'Rome was' });
assert.deepEqual(early.log.at(-1)?.body, { text: 'Rome was', stopped: true });

// The stop arrives just after the reply finished.
const late = simulate(agent, {});
late.input('say', { text: 'tell me about Rome' });
late.ok('reply:1', { text: 'Rome was founded in 753 BC.' });
assert.equal(late.input('stop', {}).rejected, 'nothing to stop');
assert.equal(late.snapshot.replying, null);

// A steer during a reply is given to the next one.
const steered = simulate(agent, {});
steered.input('say', { text: 'tell me about Rome' });
steered.input('steer', { text: 'keep it short' });
steered.ok('reply:1', { text: 'Rome was founded in 753 BC, and' });
assert.deepEqual(steered.effect('reply:2').args, { steers: ['keep it short'] });

// A second message while one is being answered is refused, not run beside it.
assert.equal(steered.input('say', { text: 'and Paris?' }).rejected, 'still replying');
```

The same holds for a config change: it is a message, taken between two others,
so a step never sees config change under it.

## The proof

- **The test above runs in our docs check.**
- **The conformance scenarios check it on every runner:** inputs are taken in
  the order they were sent, a step is answered only once it is saved, and
  everything a step returns is saved together.
