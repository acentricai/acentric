# Acentric

A harness for agents that you host yourself. A developer writes an agent as code and deploys it
to an engine. The engine keeps each running agent, an actor, in its database, runs its model
calls and tools, and picks up where it was after a crash. Actors can work on machines: your own,
which connect out to the engine, or ones the engine makes at a sandbox provider.

> **There is nothing to install yet.** This repository is being built in the open, from its
> foundation up. Today it has the contracts, the engine's core on SQLite, and four model
> providers: OpenAI, ChatGPT, Fireworks and Anthropic. It has no server and no command yet.

## What is here

| Folder              | Package              | What it is                                                             |
| ------------------- | -------------------- | ---------------------------------------------------------------------- |
| `packages/agent`    | `@acentric/agent`    | What a developer writes an agent with: the `Agent` class and `tool()`. |
| `packages/client`   | `@acentric/client`   | A typed client of the engine's API and of an actor's event stream.     |
| `packages/protocol` | `@acentric/protocol` | The contracts every part is built against.                             |
| `packages/ai`       | `@acentric/ai`       | Calls model providers.                                                 |
| `packages/core`     | `@acentric/core`     | The engine as a library, built on interfaces alone.                    |
| `packages/store`    | `@acentric/store`    | Where the engine keeps what it has, on SQLite.                         |
| `packages/executor` | `@acentric/executor` | Runs an agent's code outside the server's process.                     |
| `packages/sandbox`  | `@acentric/sandbox`  | Makes machines at sandbox providers.                                   |
| `apps/server`       | `@acentric/server`   | The server: the API, sign-in, and the engine.                          |
| `apps/cli`          | `acentric`           | The command: sign in to an engine, start a project, deploy.            |
| `apps/machine`      | `acentric-machine`   | The daemon that runs on a machine, in Rust.                            |

A developer installs `@acentric/agent`, `@acentric/client` and `acentric`. The other packages
are what the server is made of: they are published so that the server can be installed, and
they may change in any release.

Which package may depend on which is written down in `boundaries.json`, and checked.

## Working on it

It needs Node 24 or newer, pnpm, and Rust for the daemon (`rust-toolchain.toml` says which).

```sh
pnpm install
pnpm check        # formatting, lint, boundaries, build and tests
pnpm check:rust   # the same for the daemon
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Security

Please report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE).
