# @acentric/runner-memory

A runner that keeps everything in memory, for tests, scripts and trying
agents out. It follows [RUNNERS.md](../../RUNNERS.md) and passes every
[conformance](../../packages/conformance) scenario, including `durable`,
`upgrade`, `journal` and `fork`.

```ts
import { createMemoryRunner } from '@acentric/runner-memory';

const runner = createMemoryRunner({ secrets: { OPENAI_API_KEY: '...' } });
const agent = runner.load(myAgent, myHandlers);
const { id } = runner.create(agent, { model: 'small' });

await runner.input(id, 'chat', { text: 'hello' }); // answered once its step is saved
runner.log(id);
runner.view(id);
```

## How it runs

Each session has a mailbox. Messages are taken one at a time: the step
runs, its whole result is checked (Json, view, window, duplicate keys),
and then the snapshot, log entries, config and effects are applied
together. Only then do cancelled and aborted handlers get their signal, new
handlers start, and the caller get its answer. A step that fails applies
nothing. A failed input or config change is answered `failed`; a failed
effect or `migrated` step stops the session, and `fault(id)` says why.

Handlers run in this process, concurrently. Their results join the mailbox
in the order they finish. A result for a key that was cancelled meanwhile
is discarded.

| Option        | Default    | Means                                                   |
| ------------- | ---------- | ------------------------------------------------------- |
| `store`       | a new one  | where state is kept; see below                          |
| `secrets`     | none       | values handlers read with `ctx.secrets.get(name)`       |
| `clock`       | `Date.now` | the time steps see, never earlier than the newest entry |
| `timeoutMs`   | none       | a handler's time limit when it sets none                |
| `maxAttempts` | 5          | runs of a reissue key when its handler sets no limit    |

## Built-in kinds

| Kind     | Args             | Result | Does                                    |
| -------- | ---------------- | ------ | --------------------------------------- |
| `@timer` | `{ at: number }` | `null` | finishes at `at`, in ms since the epoch |

Add `MemoryRunnerKinds` to an agent's map of kinds to request it with types.

## Crashes and upgrades

The store is separate from the runner. `close()` stops a runner abruptly;
a new runner over the same store, with the same agents loaded, recovers on
`start()`: reissue effects that were running run again with the next
attempt (or fail `attempts_exhausted`), once effects are reported
`interrupted`, timers are scheduled again and effects no longer declared
are cancelled. Nothing outlives the process.

`upgrade(id, agent)` moves a session to another loaded version of its
agent between steps: `migrate` runs, and `migrated` is the first message
the new version sees. If `migrate` rejects or throws, the session stays
where it was.

## Journal and forks

Every session keeps a journal: `journal(id)` lists what it received, each
entry with its time, version, answer and digest. `replay` from
`@acentric/testing` replays it.

`fork(id, { at })` forks a session at a journal entry, the newest by
default: a new session with the state the original had then, which goes its
own way. Effects that had finished stay finished; effects that were running
start again at attempt 1, and once effects are reported `interrupted`.
