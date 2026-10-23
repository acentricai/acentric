# The local runner

Design decisions for `@acentric/runner-local`, the runner people use on their
own machine or a single server. It follows [RUNNERS.md](../RUNNERS.md). The
memory runner is for tests; this one keeps instances across restarts. This
file records what was decided and why; open topics are listed at the end.

## Shape

The runner is the process that stays alive: it fires timers, runs handlers
and holds long-lived effects. It comes in three layers:

```
core library      createLocalRunner({ store })     Node apps can use it directly
protocol server   acentric-runner --store ... --listen stdio | ws://...
client SDKs       TypeScript first; the protocol is the contract
```

- **Embedded:** an app in any language starts the runner as a child process
  and talks to it over stdin and stdout. The runner lives as long as the app:
  when stdin closes, it shuts down. While the app is closed, timers do not
  fire and approvals wait; on the next start, recovery fires overdue timers
  and reruns interrupted effects.
- **Standalone:** the same protocol over a local WebSocket, for `acentric dev`,
  `acentric start` and the dev UI. Both transports are built from the start.
- **One owner per store.** A lock file makes a second runner on the same store
  fail clearly.
- **Stdout is the protocol.** Console output from handlers goes to stderr.

## Store

A narrow `Store` interface shaped around what the runner does, so any backend
can implement it: `Store` in
[runners/local/src/store/types.ts](../runners/local/src/store/types.ts). Each
app chooses its store when it starts the runner; a Node app can pass its own
implementation. Opening a store takes it for one runner; a second fails with
`locked`.

| Group     | Operations                                                                        |
| --------- | --------------------------------------------------------------------------------- |
| Code      | `putBundle`, `getBundle`, `listBundles`, `deleteBundle`                           |
| Instances | `create` (the init step, atomic like commit), `load`, `list`, `pending`, `delete` |
| Steps     | `commit`, the one atomic operation; `readLog` by range; `findFinished`            |
| Requests  | `findRequest`, `putRequest` for answers given without a step                      |
| Between   | `putResult`, `inbox`, `dropResult`, `recordAttempt`, `setFault`                   |

Two stores come with the runner:

- **SQLite** (`sqlite:PATH`), through Node's built-in `node:sqlite`: each
  commit is one transaction, and exclusive locking takes the file.
- **Plain files** (`fs:DIR`): a journal per instance, where each commit is one
  appended, synced line with a checksum, and a checkpoint every 500 lines.
  A last line half written by a crash is cut off on the next open; any other
  damaged line is refused. A lock file holds the owner's pid, and a lock
  left by a process that is gone is taken over.

A commit holds the snapshot, log appends, config or agent changes, effects
started, finished and aborted, the result it consumed and the input id it
accepted. When `commit` resolves, all of it is durable, or none of it is.

| Decision       | Choice                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Effect results | A durable inbox: a result is saved as soon as its handler returns, so a crash before the step does not lose it      |
| Input ids      | Kept forever with their answer and a payload hash. The same id gets the same answer; a different payload is refused |
| Finished keys  | Kept forever, looked up by index for newly declared keys, never loaded whole                                        |
| History        | Never deleted by default; only a whole instance is deleted                                                          |
| Code           | Bundles live in the store by hash, so a store is self-contained                                                     |
| Trust          | A store conformance suite, plus the durable runner scenarios over each store                                        |

Input ids and finished keys grow with the log, which is kept forever, so
bounding them would save little and risk applying an input twice.

## Protocol

JSON-RPC 2.0, one message per line on stdio, the same messages over
WebSocket. A rejection or a failed step is a normal result; JSON-RPC errors
are only for protocol problems, such as an unknown instance or bad params,
and their `data.code` names the problem. The messages are typed in
`@acentric/protocol`; `@acentric/client` speaks them.

**Requests from the app:**

| Method                                     | Does                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `initialize`                               | Agrees on the protocol version, names the client, declares kinds it provides      |
| `agents/deploy`                            | Installs a bundle under a name and version; the same bundle again is a no-op      |
| `agents/list`                              | Installed agents and how many instances use each                                  |
| `instances/create`                         | Runs init and returns the instance id; a caller-chosen id makes it idempotent     |
| `instances/input`                          | Sends an input; answered after its step is saved                                  |
| `instances/configure`, `instances/upgrade` | Changes the config, or moves the instance to another installed version            |
| `instances/get`                            | Agent, status, view and running effects now; the snapshot if asked, for debugging |
| `instances/list`                           | Instances by agent or status, paged                                               |
| `instances/log`                            | A range of the log                                                                |
| `instances/delete`                         | Cancels running effects and removes the instance                                  |
| `instances/subscribe`, `unsubscribe`       | Starts or stops notifications, under a subscription id the client chooses         |
| `secrets/set`                              | Sets a secret in memory only                                                      |

**Notifications from the runner,** while subscribed:

| Notification | Sent when                                                         |
| ------------ | ----------------------------------------------------------------- |
| `log`        | A step appended entries. Gapless from `after`: history, then live |
| `view`       | A step changed the view                                           |
| `emit`       | A handler streamed a delta. Live only, never stored or replayed   |
| `status`     | The instance became idle, busy or faulted                         |

A subscription's id is the client's, so notifications that arrive before
the answer to `instances/subscribe`, such as the replayed history, already
say where they belong.

**App-provided handlers.** A bundle names the kinds an app will provide, with
their mode and limits, when it is deployed (`provides`). An app that provides
them says so at `initialize`. The runner sends it `effect/run`; the app
streams `effect/emit` and answers `{ ok }` or `{ error }`; the runner sends
`effect/cancel` as the signal. The runner keeps timeouts, attempts, the inbox
and recovery, so the agent cannot tell an app-provided effect from any other.
An effect waits while no provider is connected. If the provider disconnects
mid-effect, that is a crash for its effects: reissue effects run again when a
provider connects, once effects are reported interrupted.

**Deploying:** a bundle is passed by path for local use, or inline for apps
that ship it themselves.

**The process:** `acentric-runner --store sqlite:PATH --listen stdio` (the
default) or `--listen ws://HOST:PORT`, with `--secret NAME` to take a secret
from the environment and `--host-import MODULE` for a module handler hosts
load first. Over stdio it stops gracefully when stdin closes; over WebSocket,
on SIGINT or SIGTERM.

## Agent code

A bundle is two self-contained ES modules and a manifest:

```
agent.js       the pure half; no imports, dependencies bundled in
handlers.js    the I/O half; npm dependencies bundled, Node built-ins allowed
manifest.json  { name, version, hash, kinds, sdkVersion }
```

- `kinds` lets the runner check at deploy and create time that every kind is
  covered by the bundle's handlers, the app or the runner.
- Code under a version never changes. `acentric dev` deploys
  `<version>-dev.<hash>` on every save, and hot reload is an upgrade.
  Unused dev versions are removed automatically; real versions never are.
- **Step** runs in the runner's main thread on frozen inputs. Purity is
  checked at build time.
- **Handlers** run in handler hosts: a child process per agent version that
  loads `handlers.js` and speaks the same `effect/run`, `effect/emit` and
  `effect/cancel` messages as app-provided handlers. A crashing or hanging
  handler takes down only its host, and dropping an old version means ending
  its host, which also frees its modules.
- **Faults** are cleared by deploying a fixed version and upgrading the
  instance; the message that failed is then retried on the new code.

## Internals

**One step at a time per instance,** as in the memory runner, with the store
awaited in between:

1. Take the next message: an input, or a result from the durable inbox.
   Results are taken in the order they were saved.
2. Load the state: the snapshot and the window's entries, from memory if the
   instance is loaded, from the store if not.
3. Run step, synchronously, on frozen inputs.
4. Check the result: Json, view, the effects to start, cancel and abort.
   Newly declared keys are looked up among finished keys in one batch.
5. Commit.
6. Act: answer the caller, cancel, abort and start effects through their
   hosts, notify subscribers. Nothing outside sees a step before its commit.

**Loaded on demand.** Only active instances are kept in memory: the snapshot,
the tail of the log and the effects. An instance is loaded when an input, an
inbox result or a timer needs it, and unloaded after a while idle. An instance
waiting for a person needs nothing in memory.

**Timers.** One scheduler holds the due times of every running `@timer`,
filled from the store on start. Overdue timers fire at once; timers past
`setTimeout`'s limit of about 24.8 days are armed again in chunks.

**Recovery on start,** for every instance with running effects or inbox
results:

1. Inbox results are stepped first. A `once` effect whose result reached the
   inbox finished, so it is not reported interrupted.
2. `effects()` is computed again from the saved state; keys no longer declared
   are cancelled.
3. Running `reissue` effects run again with the next attempt, recorded before
   they start, or fail `attempts_exhausted`. Running `once` effects are
   reported `interrupted`. Timers go back to the scheduler. App-provided
   kinds are sent again when their provider connects.

**Handler hosts** start on the first effect for their agent version and stop
when no instance uses it. The runner enforces time limits, so a frozen host
cannot hold an effect forever. A host that crashes counts as a crash for its
own running effects only: `reissue` effects run again with the next attempt,
`once` effects are interrupted, and the host restarts with backoff.

**Many instances.** Steps of different instances interleave; each is short
and synchronous, so a slow step delays every instance. SQLite serializes
commits. A slow subscriber has its `emit`s dropped or merged rather than
buffered without limit; `log` notifications are never dropped, since a
subscriber can catch up from the store.

**Shutdown.** Stop taking requests, finish commits in progress, give running
handlers a grace period (configurable, 5 s by default), then signal and stop
the hosts. Anything still running stays declared and is recovered on the next
start, as after a crash.

## Developer tooling

One package, `@acentric/cli`, gives the `acentric` command; `npm create
acentric` scaffolds a project.

| Command                                    | Does                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `acentric dev`                             | Runs a dev runner, rebuilds on save, hot-reloads instances, serves the dev UI |
| `acentric build`                           | Type-checks, bundles, checks purity, writes manifests                         |
| `acentric start [--stdio]`                 | Runs the runner on built bundles, over WebSocket or stdio                     |
| `acentric ls`, `log -f`, `send`, `upgrade` | Inspects and drives a running runner over its WebSocket                       |

**A project** holds one or more agents:

```
my-agent/
  src/agent.ts          pure half
  src/handlers.ts       I/O
  test/agent.test.ts    simulator tests
  acentric.config.ts    agents, store, secrets, kinds the app provides
  .env                  secrets for dev
  .acentric/            dev store and build output
```

Versions come from `package.json`, or per agent in the config.

- **Build** bundles each agent with esbuild. `agent.js` may import nothing and
  use no forbidden globals such as `fetch`, timers or `process`; `handlers.js`
  bundles its dependencies and may use Node built-ins. The globals are found
  by bundling the pure half again with each one defined as a marker: esbuild
  replaces only free references, so a local variable of the same name is not
  mistaken for the global. `Date.now` and `Math.random` give warnings. The
  manifest lists the kinds the agent uses, from the optional `kinds` list on
  `Agent`, and the kinds the handlers cover; a listed kind that nothing
  handles or provides fails the build. The project is type-checked first with
  its own TypeScript.
- **Dev** deploys `<version>-dev.<hash>` on every save and upgrades the
  agent's instances, keeping their state through `migrate`. If the upgrade
  fails, instances stay on the previous code and the error is shown. A fault
  is fixed by saving the fix: the upgrade clears it and the failed message is
  retried.
- **The dev UI** is a web page served by `acentric dev`, built only on the
  protocol: instances, creating one, sending inputs as Json, the log, the
  view, live emits, running effects and faults. The same port serves the
  protocol over WebSocket and a stream of dev events: builds, deploys and
  upgrades. Dev keeps its own store, apart from the one `start` uses. A dev
  version is named by a hash of its code, so saving code back to an earlier
  state brings back that version's name.
- **Start** deploys the built bundles on boot, a no-op when unchanged, and
  listens on WebSocket, or stdio when an app starts it as a child process.

## Smaller decisions

- **`secrets/set`** passes a secret the app holds, such as a key a user typed
  in. It is kept in memory only, never stored, and gone when the runner stops.
- **A provided kind with no provider connected** waits until one connects;
  the handler's time limit still applies.
- **Two clients providing the same kind:** the first to declare it handles
  it, and a second declaration is refused.
- **Step runs without a sandbox** for now: the build-time purity check and
  frozen inputs. A `vm` context without Node globals is for later.

## Plan

Each milestone ends in something runnable and tested.

1. **Core runner, SQLite store and handler hosts.** Done. The optional `kinds`
   list on `Agent`; the `Store` interface, the SQLite store and the store
   conformance suite; the engine with its inbox, input ids, finished-key
   lookups, on-demand loading, timers, recovery and shutdown; handler hosts
   as child processes. Verified by every conformance scenario, crashing by
   abandoning the runner, killing its hosts and reopening the store.
2. **Protocol server and TypeScript client.** Done. JSON-RPC over stdio and
   WebSocket with every method and notification, app-provided handlers, and
   `@acentric/client`. Verified by the scenarios through the protocol, where a
   crash kills the runner process, and by pi on a real model over stdio.
3. **`acentric build` and `acentric start`.** Done. Bundling, the purity check,
   manifests, kind coverage, deploying on boot. Verified by building pi and
   driving it with `acentric send` and `acentric log -f`.
4. **`acentric dev` and the dev UI.** Done. Watching, dev versions, hot reload
   through upgrades, faults cleared on save. Verified by editing an agent
   while an instance is mid-conversation.
5. **The filesystem store,** passing the same suite and scenarios. Done.
6. **`npm create acentric` and templates.** Done, with the `minimal` template;
   more templates, and helpers that make agents easier to write, are next.

## Open

- Node does not unload modules, so every dev version's pure half stays in
  the dev runner's memory until it restarts. Loading pure halves in worker
  threads would let old ones go.

- Grouping several commits into one fsync, for throughput.
- Templates that make writing an agent easier than the initial pure half and
  handlers pair.
- Running step in a `vm` context without Node globals.
