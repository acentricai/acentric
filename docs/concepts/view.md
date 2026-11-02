# The view

_What callers see of a session, apart from what the agent keeps._

The snapshot is the agent's private memory. It holds what the agent needs to
decide, including internals such as effect keys, and its shape changes whenever
you rewrite the agent. The **view** is what everyone else sees: a JSON object
computed from the state, in a shape you keep stable for the apps and people
reading it.

Here is a view for the [chat agent](effects.md). A UI needs to know
whether a reply is being written, not the reply's key or prompt:

`src/view.ts`:

```ts title="src/view.ts"
import type { NoConfig, View } from '@acentric/types';

type Snapshot = { replying: { key: string; prompt: string; stop: boolean } | null };

export const view: View<Snapshot, NoConfig> = ({ snapshot }) => {
  const { replying } = snapshot;
  if (replying === null) return { status: 'idle' };
  return { status: replying.stop ? 'stopping' : 'replying' };
};
```

The agent includes it as `view`, beside `step` and `effects`.

## What callers see

`view(state)` sees the same state as `step`: the snapshot, the log window and
config. It returns any JSON object. It is pure, and like `effects` it takes no
`now`, so it depends on the state alone. A view cannot say "3 minutes ago"; it
can give the time, and the UI formats it.

The local runner computes the view after every step and saves it with the step,
so reading a view runs no agent code. A subscriber hears the view when it
subscribes, and again whenever a step changes it:

`src/app.ts`:

```ts title="src/app.ts"
import { connectWebSocket } from '@acentric/client';

const client = await connectWebSocket('ws://127.0.0.1:7420');
const { id } = await client.create('chat@0.1.0', {});
if (id === undefined) throw new Error('the session was not created');

await client.subscribe(id, {}, (event) => {
  if (event.type === 'view') console.log('view', event.view);
});
await client.input(id, { kind: 'say', payload: { text: 'hello' } });
```

Because the view is computed with the step, a view that throws or returns
something that is not JSON fails that step, and nothing is applied. An agent
that leaves `view` out has no view: callers see `null`, and the log.

## View or snapshot?

Callers see the view, not the snapshot, for three reasons:

- **It hides internals.** Effect keys, prompts kept for a handler, counters:
  none of that is an app's business.
- **It stays stable.** You can reshape the snapshot in any new version, and
  `migrate` moves old sessions over. As long as `view` returns the same shape,
  no app notices.
- **It can derive.** A view can count, convert or combine, like the
  [weather agent](messages.md) giving temperatures in the units its
  config asks for.

The snapshot is still there for debugging: `acentric get <id> --snapshot` shows
it. Apps should not depend on it.

## View and log

An app reads two things from a session, each for its own job:

| Read     | It is                                  | Use it for                                  |
| -------- | -------------------------------------- | ------------------------------------------- |
| The view | The session now, replaced on each step | Status, counts, what to show at a glance    |
| The log  | Everything that happened, in order     | A chat transcript, an activity feed, audits |

The chat agent's UI shows its status from the view, and its transcript from the
`user` and `assistant` log entries. A reply appears in the log once it is
finished, and the log is the record.
