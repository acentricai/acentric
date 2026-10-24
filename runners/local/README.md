# @acentric/runner-local

A runner for your own machine or a single server. It keeps sessions in a
store, so they survive restarts, and runs handlers in child processes, so a
handler that crashes or hangs takes down only its host. It follows
[RUNNERS.md](../../RUNNERS.md) and passes every
[conformance](../../packages/conformance) scenario, including `durable` and
`upgrade`. The design is in [docs/local-runner.md](../../docs/local-runner.md).

```ts
import { createLocalRunner, openSqliteStore } from '@acentric/runner-local';

const store = await openSqliteStore('./agents.db');
const runner = createLocalRunner({ store, secrets: { OPENAI_API_KEY: '...' } });
await runner.start(); // recovers what the store holds

await runner.deploy({ name: 'pi', version: '0.1.0', agent: agentSource, handlers: handlersSource });
const { id } = await runner.create({ name: 'pi', version: '0.1.0' }, { cwd, model });

const stop = await runner.subscribe(id, {}, (event) => console.log(event));
await runner.input(id, { id: 'u1', kind: 'prompt', payload: { text: 'hello' } });

await runner.close(); // lets running handlers finish, then stops
await store.close();
```

## As a process

`acentric-runner` serves the [protocol](../../packages/protocol) over stdio
or WebSocket, for applications in any language; in TypeScript,
[@acentric/client](../../packages/client) starts and speaks to it.

```sh
acentric-runner --store sqlite:./agents.db                       # stdio, until stdin closes
acentric-runner --store sqlite:./agents.db --listen ws://127.0.0.1:7420
```

| Flag                                                        | Means                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `--store sqlite:PATH`                                       | the store                                                 |
| `--listen`                                                  | `stdio` (the default) or `ws://HOST:PORT`                 |
| `--code-dir DIR`                                            | where deployed modules are written                        |
| `--secret NAME`                                             | takes a secret from the environment variable of that name |
| `--host-import MODULE`                                      | a module handler hosts load before the handlers           |
| `--grace-ms`, `--idle-ms`, `--timeout-ms`, `--max-attempts` | as the options below                                      |

Stdout carries only the protocol: console output, the runner's and its
handlers', goes to stderr.

## Code

A deployed agent is two self-contained ES modules: the pure half, whose
default export is the agent without handlers, and the handlers module,
whose default export is the handlers. Code is stored by hash; deploying the
same code again changes nothing, and different code under a deployed name
and version is refused. Deploying loads the handlers in a host to read their
kinds, and refuses an agent that lists a kind in `kinds` with no handler.

## How it runs

Each session has a mailbox, and its jobs run one at a time. A step's whole
result is checked and committed in one write; only after the commit do
handlers start or get their signal, callers get their answer and
subscribers hear of it. When a handler finishes, its outcome is saved to a
durable inbox before its step runs, so a crash in between loses nothing.

| Request                    | Retry with the same id                            |
| -------------------------- | ------------------------------------------------- |
| `input` with an input `id` | gets the same answer; the step does not run again |
| `configure` with an id     | the same                                          |
| `create` with an `id`      | the same, if the agent and config are the same    |

Sessions are loaded when needed and unloaded after `idleMs`. A faulted
session takes no more messages until it is upgraded to a version that fixes
it; the result whose step failed is then stepped again.

| Option        | Default       | Means                                                   |
| ------------- | ------------- | ------------------------------------------------------- |
| `store`       | required      | where everything is kept                                |
| `codeDir`     | a temp folder | where deployed modules are written to be imported       |
| `secrets`     | none          | values handlers read with `ctx.secrets.get(name)`       |
| `clock`       | `Date.now`    | the time steps see, never earlier than the newest entry |
| `timeoutMs`   | none          | a handler's time limit when it sets none                |
| `maxAttempts` | 5             | runs of a reissue key when its handler sets no limit    |
| `graceMs`     | 5000          | how long `close` waits for running handlers             |
| `idleMs`      | 5 minutes     | how long an idle session stays loaded                   |
| `host`        | none          | Node options, environment and idle time for hosts       |

## Recovery

`start` recovers every session with running effects or inbox results:
inbox results are stepped first, reissue effects that were running run
again with the next attempt (or fail `attempts_exhausted`), once effects
that were running are reported `interrupted`, and timers are scheduled
again. A host that crashes is the same, for its own effects only.

## Journal and forks

Every session keeps a journal of what it received, saved with each step:
`journal(id)` reads it a page at a time, and `replay` from
`@acentric/testing` replays it. `fork(id, { at, id })` forks a session at a
journal entry, the newest by default: the new session has the state the
original had then, rebuilt by replaying the journal and checked against its
digests. Effects that had finished stay finished; effects that were running
start again at attempt 1, and once effects are reported `interrupted`.
Sessions created before journals keep none, and cannot be forked.

## Built-in kinds

| Kind     | Args             | Result | Does                                    |
| -------- | ---------------- | ------ | --------------------------------------- |
| `@timer` | `{ at: number }` | `null` | finishes at `at`, in ms since the epoch |

## Stores

Two stores come with the runner, and pass the same store suite and every
conformance scenario. `openStore('sqlite:PATH')` or `openStore('fs:DIR')`
opens either, as `--store` does.

**SQLite,** `openSqliteStore(path)`: everything in one file, through Node's
built-in `node:sqlite`. Each commit is one transaction.

**Plain files,** `openFileStore(dir)`: a folder you can read, tail, grep and
back up.

```
lock                              the pid of the runner that has it open
agents/<name>/<version>/          bundle.json, agent.js, handlers.js
sessions/<id>/journal.jsonl      one line per write: a checksum, then the record
sessions/<id>/checkpoint.json    the session as of a place in its journal
```

Each commit is one journal line, appended and synced, so it is saved whole
or not at all. A last line half written by a crash is cut off when the
session is next opened; a damaged line before it is refused. Log entries
stay on disk and are read by range through an index of which lines hold
which seqs. A checkpoint every 500 lines keeps opening a session from
replaying its whole history. New sessions and bundles are written to a
temporary folder and renamed into place. A lock left by a process that is
gone is taken over.

Either store takes its file or folder for one runner at a time. Any backend
that implements `Store` works; `test/store-suite.ts` is what it must pass.
