# What it costs

_What the model asks of you, and when a plain loop is the better choice._

Every claim in this section comes at a price. This page is the price, so you
can decide whether it is worth paying.

## Waiting is written down

A loop's call stack remembers where it is for free. A reducer has to say it:
what it is waiting on, and what to do when each answer arrives. The
[overview](README.md) shows the cost plainly: an eight-line loop becomes an agent of
about seventy lines.

Those lines are not wasted. They are the states the loop had all along, and
every claim in this section depends on their being written down. But they are
more code to write and read, and a first version takes longer.

## I/O lives somewhere else

`step` cannot call a model, read a file or fetch a page; it declares an effect,
and a handler does the work. Code that does I/O in the middle of its logic has
to be split at each call.

Libraries built around a loop, such as an SDK's tool-calling runner, do not fit
inside `step`. They can run inside a handler, as one effect, or be replaced by
the agent's own logic. The model provider's plain client works well in a
handler.

## Everything is JSON

State, messages, args and results are plain JSON, so a runner can save and move
them. There is no `Date`, `Map`, class instance or `undefined`: times are
numbers, and sets are arrays. A runner refuses a step that returns anything
else, so the mistake shows up at once, but it is a habit to learn.

## The snapshot is rewritten every step

A runner saves the whole snapshot on every step. A snapshot of a few kilobytes
costs nothing; a snapshot holding a whole conversation costs more on every
message. History belongs in the log, which is written once, with `window`
choosing how much of it a step sees. [State](../concepts/state.md#snapshot-or-log)
explains where things go.

## Handlers can run twice

A runner that crashes while a `reissue` handler runs will run it again, so a
handler must be safe to repeat. For an API that takes payments or sends
messages, that means an idempotency key. The effect's key is one, the same on
every run:

`src/handlers.ts`:

```ts title="src/handlers.ts"
import type { HandlersFor } from '@acentric/types';

type Kinds = {
  charge: { args: { customer: string; cents: number }; result: { id: string } };
};

const handlers: HandlersFor<Kinds> = {
  charge: {
    // Safe to repeat: the provider charges once per idempotency key.
    mode: 'reissue',
    run: async ({ key, args, signal, secrets }) => {
      const response = await fetch('https://payments.example.com/charges', {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${await secrets.get('PAYMENTS_KEY')}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error(`the charge failed: ${response.status}`);
      const charge: { id: string } = await response.json();
      return { id: charge.id };
    },
  },
};

export default handlers;
```

Where no such key exists, a handler can be `once` instead. It never runs twice,
and the agent receives `interrupted` after a crash, and decides what to do.
Either way, the question has to be answered for each handler. A loop faces the
same question after a crash, but usually does not ask it.

## One message at a time

A session takes one message at a time, so a slow `step` holds up everything
behind it. `step` should decide and return; slow work, such as parsing a large
document, belongs in a handler. Sessions run side by side, and so do the
effects of one session, but one session's steps never do.

## Thinking in states

When something goes wrong, there is no stack trace through the agent's whole
run. There is a sequence of states, the log, and the messages in between.
Most people find this easier to debug once used to it, because each step can
be checked on its own, but it is a different habit from stepping through a
loop.

## When a loop is better

A loop is the better choice when none of the claims matter:

- a script that runs once and exits;
- a prototype, while the prompt and tools are still changing every hour;
- an agent that never waits long, never needs stopping, testing in parts or
  upgrading, and can lose a run to a crash.

Moving a loop to a reducer later is mostly writing down its waits: each `await`
becomes a state the agent is in, and an effect it declares.
