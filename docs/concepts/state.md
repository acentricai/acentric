# State

_What a session keeps: a small snapshot, a log written once, and its config._

Everything an agent knows when it handles a message is its **state**, which
has three parts:

```ts
type State<S, C> = {
  snapshot: S; // what the agent remembers now
  log: LogWindow; // the part of its history this step can see
  config: C; // settings from whoever created the session
};
```

Each part has a different owner and changes in a different way. `step` reads
all three, but only returns a new snapshot and new log entries. It never
changes the state it was given.

All state is plain JSON: objects, arrays, strings, numbers, booleans and
`null`. That rule is what lets a runner save a session, move it, and load it
back exactly as it was. It rules out `undefined`, `Date`, `Map` and class
instances.

## The snapshot

The snapshot is the agent's working memory: the open notes, the pending
reminders, the turn of the conversation. Every step returns a whole new
snapshot, and the runner saves it in place of the old one.

Because it is rewritten on every step, keep it small. It should hold what the
next decision needs, not everything that ever happened. To leave it
unchanged, return the one you were given.

## The log

The log is the agent's history. A step adds entries with `append`, and the
runner numbers each one (`seq`) and stamps it with that step's `now` (`at`):

```ts
return {
  snapshot,
  append: [{ kind: 'added', body: note }],
};
```

An entry is written once. Nothing edits or removes it, and the runner saves it
together with the snapshot from the same step, so they can never disagree. The
log is where history and anything large belongs: messages, model replies, tool
output.

## The window

A log grows for as long as a session lives, so a step does not see all of it.
Before each step the runner loads a **window**: every entry from some starting
`seq` up to the newest. The agent chooses where the window starts with
`window(snapshot)`.

This agent remembers only the last 20 things it was told. `log.next` is the
`seq` the step's own entry will receive, so each step moves the start of the
window to keep the 20 newest, counting its own:

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent } from '@acentric/types';

type Snapshot = { since: number };

const agent: Agent<Snapshot> = {
  name: 'recent',
  version: '0.1.0',

  init: () => ({ snapshot: { since: 1 } }),

  step: ({ snapshot, log }, message) => {
    if (message.type !== 'input') return { snapshot };
    return {
      snapshot: { since: Math.max(1, log.next - 19) },
      append: [{ kind: message.kind, body: message.payload }],
    };
  },

  window: (snapshot) => snapshot.since,

  view: ({ log }) => ({ recent: log.entries.map((entry) => entry.body) }),
};

export default agent;
```

`window` reads the snapshot alone, because it decides which part of the log to
load. It can move backwards, to look at older entries again for a while.

Entries before the window are still stored, and a handler can read any part of
the log. A step reaches older history that way, as an
[effect](effects.md). The common case is a chat agent that asks a model
to summarise its old turns, appends the summary, and starts its window there.

Leave `window` out and every step sees the whole log. That is fine for an
agent whose history stays short.

## Config

Config holds the settings a session was created with, such as a model name or
a system prompt. It is given at creation and passed to `init`.

A step cannot change config. Only a `config` [message](messages.md)
does that. The message carries the new config, while the state still holds the
current one, so the step can compare them. If the step accepts, the new config
applies from then on; if it rejects, the current one stays. An upgrade's
`migrate` can also reshape config.

Never put secrets in config, or anywhere in state: everything there is stored.
Handlers ask for secrets by name.

## Snapshot or log?

Ask whether the next decision needs it:

| Put it in     | When                                                | For example                                                  |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| The snapshot  | Steps read it to decide, and it stays small         | A notes agent's open notes and pending reminders             |
| The log       | It records what happened, or grows without bound    | The notes agent's `added`, `done` and `reminder` entries     |
| A bit of both | A long history needs a short form for each decision | A chat's summary point in the snapshot, its turns in the log |

A good sign you have it right is that the snapshot stays the same size
however long the session runs.
