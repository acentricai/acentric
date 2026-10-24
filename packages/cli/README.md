# @acentric/cli

The `acentric` command: build a project's agents into the bundles a runner
deploys, start a runner with them, and inspect and drive a running one.

```sh
acentric dev                       # a dev runner and UI on http://127.0.0.1:7420, hot-reloading on save
acentric build                     # bundle, type-check, check purity, write manifests
acentric start                     # a runner on ws://127.0.0.1:7420 with the built agents
acentric create pi@0.1.0 '{"cwd": "/work", "model": {"provider": "openai", "id": "gpt-5.4-mini"}}'
acentric send <id> prompt '{"text": "fix the tests"}'
acentric log <id> -f               # the log, then each step live
```

## The project

```ts
// acentric.config.ts
import { defineConfig } from '@acentric/cli/config';

export default defineConfig({
  agents: {
    pi: { agent: 'src/entry/agent.ts', handlers: 'src/entry/handlers.ts' },
  },
  secrets: ['OPENAI_API_KEY'],
});
```

| Field     | Default                     | Means                                                        |
| --------- | --------------------------- | ------------------------------------------------------------ |
| `agents`  | required                    | each agent's two modules, version and kinds the app provides |
| `store`   | `sqlite:.acentric/store.db` | the store `start` uses: `sqlite:PATH` or `fs:DIR`            |
| `listen`  | `ws://127.0.0.1:7420`       | where `start` listens                                        |
| `secrets` | none                        | environment variables handlers get; `.env` is read first     |
| `outDir`  | `.acentric/build`           | where `build` writes bundles                                 |

Each agent's `agent` module default-exports its pure half and its
`handlers` module default-exports its handlers. An agent's version defaults
to the project's `package.json` version.

## dev

Builds every agent, deploys each as `<version>-dev.<hash>`, where the hash
names the code, and watches the project. On every save it builds again,
deploys the new code and upgrades the agent's sessions to it, so they keep
their state, through `migrate` if the agent has one. Because hot reload is
an upgrade:

- An effect running during a save keeps running, and the new code steps its
  result.
- A session faulted by a bug is fixed by saving the fix: the upgrade clears
  the fault, and the message that failed is stepped again on the new code.
- A build that fails is reported, and sessions keep the code they had.

Old dev versions no session uses are removed. Dev keeps its own store,
`.acentric/dev.db`, apart from the one `start` uses, and does not type-check:
run `acentric build` for that.

One port serves the dev UI, the protocol over WebSocket, and the dev events
the UI shows. The UI is built only on the protocol: sessions and creating
one, sending inputs, the log with each entry expandable, the view, running
effects, faults, and each build, deploy and upgrade.

## build

For each agent, writes `agent.js`, `handlers.js` and `manifest.json` to
`<outDir>/<name>/`:

- The project is type-checked first with its own TypeScript, if it has a
  `tsconfig.json`; `--no-typecheck` skips it.
- `agent.js` bundles the pure half with everything it imports. It may not
  import Node modules or use globals that do I/O, such as `fetch`, timers or
  `process`. Using `Date.now` or `Math.random` gives a warning: steps should
  use the `now` they are given.
- `handlers.js` bundles the handlers and their npm dependencies; Node
  built-ins are allowed.
- `manifest.json` has the name, version, the hash the runner will give the
  bundle, the kinds the agent lists, and the kinds the handlers cover. A
  listed kind that nothing handles or provides fails the build.

## start

Runs the local runner on the built bundles: reads `.env`, passes the
config's secrets to handlers, and deploys each bundle, which changes nothing
for one already deployed. Changed code under a deployed version is refused:
give it a new version. `--stdio` serves the protocol on stdin and stdout, for
an application that starts it as a child process; otherwise it listens on
WebSocket until Ctrl-C, then stops gracefully.

## Inspecting a runner

These talk to the runner at `--url`, or the project's `listen`.

| Command                                   | Does                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `agents`                                  | deployed agents and their session counts                                                       |
| `ls`                                      | sessions, with status and entry counts                                                         |
| `create <agent@version> [config] [--id]`  | creates a session and prints its id                                                            |
| `send <id> <kind> [payload] [--input-id]` | sends an input and prints the answer                                                           |
| `get <id> [--snapshot]`                   | status, view and running effects as JSON                                                       |
| `log <id> [-f] [--json]`                  | the log; `-f` follows it                                                                       |
| `upgrade <id> <version>`                  | moves a session to another deployed version                                                    |
| `replay <id> [--what-if]`                 | replays a session on the code that ran it, or on the project's code, and says where it differs |
| `fork <id> [--at N] [--id]`               | forks a session at a journal entry and prints the new id                                       |
