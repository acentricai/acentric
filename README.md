# Acentric

A harness for agents that you host yourself. A developer writes an agent as code and deploys it
to an engine. The engine keeps each running agent, an actor, in its database, runs its model
calls and tools, and picks up where it was after a crash. Actors can work on machines: your own,
which connect out to the engine, or ones the engine makes at a sandbox provider.

> **Nothing is published yet.** This repository is being built in the open, from its
> foundation up. Today it has the engine on SQLite, four model providers (OpenAI, ChatGPT,
> Fireworks and Anthropic), the framework an agent is written with, agents deployed as versions
> that their running actors follow, agents' code run apart from the engine in isolates of
> `workerd`, and a server with an HTTP API, API keys, sign-in for people with roles, an audit
> log, model accounts and usage, and a typed client. It has no command and no dashboard yet.

## Running the server

The server can be built from this repository as an image and run. Nothing of it is promised to
stay as it is.

```sh
docker build -t acentric-server .
docker run -p 4000:4000 -v acentric-data:/data \
  -e ACENTRIC_SECRET_KEY=<32 bytes, as 64 hex characters> \
  acentric-server
```

- It prints an API key once, when it first starts. That key may do everything, and other keys
  are made with it. To choose the key yourself, set `ACENTRIC_ADMIN_KEY`.
- It prints a setup link while it has no person yet. Whoever uses it becomes the owner. Until
  the dashboard is built there is no page behind the link: its token is sent to
  `POST /v1/setup` with an email and a password.
- People are added by invite links an admin makes. The server sends no email. An owner who is
  locked out runs `acentric-server reset-link <email>` on the server itself.
- Set `ACENTRIC_PUBLIC_URL` to where people reach the server, so that its links start there.
- It keeps everything it has in `/data`.
- `ACENTRIC_SECRET_KEY` is what agents' secrets and the keys of model accounts are sealed
  with. Without it, the server keeps neither.
- A provider's models are called with a model account: a key of the provider's, added with
  `POST /v1/accounts` and checked with the provider before it is kept. No key is read from the
  environment. The first account of a provider is its default, and an agent can be given
  another.
- Every call of a model is written down with what it used and cost. `GET /v1/usage` adds it
  up, by agent, actor, account, provider, model or day.
- Its API is described at `/v1/openapi.json`, and `@acentric/client` calls it.

Every setting is listed at the top of `apps/server/src/settings.ts`.

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
