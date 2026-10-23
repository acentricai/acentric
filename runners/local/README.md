# @acentric/runner-local

A runner for your own machine or a single server. It keeps instances in a
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

const stop = await runner.subscribe(id, { emits: true }, (event) => console.log(event));
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

Each instance has a mailbox, and its jobs run one at a time. A step's whole
result is checked and committed in one write; only after the commit do
handlers start or get their signal, callers get their answer and
subscribers hear of it. When a handler finishes, its outcome is saved to a
durable inbox before its step runs, so a crash in between loses nothing.

| Request                    | Retry with the same id                            |
| -------------------------- | ------------------------------------------------- |
| `input` with an input `id` | gets the same answer; the step does not run again |
| `configure` with an id     | the same                                          |
| `create` with an `id`      | the same, if the agent and config are the same    |

Instances are loaded when needed and unloaded after `idleMs`. A faulted
instance takes no more messages until it is upgraded to a version that fixes
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
| `idleMs`      | 5 minutes     | how long an idle instance stays loaded                  |
| `host`        | none          | Node options, environment and idle time for hosts       |

## Recovery

`start` recovers every instance with running effects or inbox results:
inbox results are stepped first, reissue effects that were running run
again with the next attempt (or fail `attempts_exhausted`), once effects
that were running are reported `interrupted`, and timers are scheduled
again. A host that crashes is the same, for its own effects only.

## Built-in kinds

| Kind     | Args             | Result | Does                                    |
| -------- | ---------------- | ------ | --------------------------------------- |
| `@timer` | `{ at: number }` | `null` | finishes at `at`, in ms since the epoch |

## Stores

`openSqliteStore(path)` keeps everything in one SQLite file through Node's
built-in `node:sqlite`, and takes the file for one runner at a time. Any
backend that implements `Store` works; `test/store-suite.ts` is what it must
pass.
