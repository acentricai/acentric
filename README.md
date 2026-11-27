# Acentric

A harness for agents that you host yourself. A developer writes an agent as code and deploys it
to an engine. The engine keeps each running agent, an actor, in its database, runs its model
calls and tools, and picks up where it was after a crash. Actors can work on machines: your own,
which connect out to the engine, or ones the engine makes at a sandbox provider.

> **Alpha.** 0.20.0 is the newest release. It runs, and is tested as it is run, but before 1.0 a
> minor version may change what the API takes and how the server is set up
> ([VERSIONS.md](VERSIONS.md)). It has the engine on SQLite; three model providers (OpenAI,
> Anthropic and Fireworks); the framework an agent is written with; agents deployed as versions
> that their running actors follow, with their code run apart from the engine in isolates of
> `workerd`; tools, scripts, MCP servers, subagents, schedules and machines; and a server with
> an HTTP API, API keys, sign-in for people with roles, an audit log, model accounts and usage,
> backups, the dashboard, and the `acentric` command.

## Running the server

The server is an image, for linux/amd64 and linux/arm64:

```sh
docker run -p 4000:4000 -v acentric-data:/data \
  -e ACENTRIC_SECRET_KEY=<32 bytes, as 64 hex characters> \
  ghcr.io/acentricai/acentric-server:0.20.0
```

That is enough to try it. To run one whose data you keep, [deploy/](deploy/) is the guide, with
a recipe for each way of running it: Docker Compose behind Caddy, Kubernetes, systemd, and
Terraform on AWS. Run an exact version, and change it on purpose: [VERSIONS.md](VERSIONS.md) says what a version
promises, how to check that an image is the one released, and what an upgrade carries over.
[CHANGELOG.md](CHANGELOG.md) says what changed in each. To build the image yourself instead,
`docker build -t acentric-server .`.

- When it first starts with no key, it makes an API key that may do everything, which other
  keys are made with, and writes it to `/data/first-admin-key`: not to its log. To choose the
  key yourself, set `ACENTRIC_ADMIN_KEY`.
- It prints a setup link while it has no person yet. Whoever uses it becomes the owner: the
  link opens the dashboard, which the server serves beside its API, and asks for an email and a
  password.
- People are added by invite links an admin makes, which open at `/invite?token=…`. The
  server sends no email. An owner who is
  locked out runs `acentric-server reset-link <email>` on the server itself.
- Set `ACENTRIC_PUBLIC_URL` to where people reach the server, so that its links start there.
- It keeps everything it has in `/data`: its database, and the images and files of
  conversations as files in `/data/blobs`. It backs itself up every day and before an upgrade,
  and `acentric-server backup` and `restore` take and put back one: see
  [BACKUPS.md](BACKUPS.md). Do not copy `/data` while it runs. What it keeps, and for how
  long: [DATA.md](DATA.md). What one server handles, and how large a machine to give it:
  [LIMITS.md](LIMITS.md).
- `ACENTRIC_SECRET_KEY` is what agents' secrets and the keys of model accounts are sealed
  with. Without it, the server keeps neither. It and the admin key are read from files too,
  by `ACENTRIC_SECRET_KEY_FILE` and `ACENTRIC_ADMIN_KEY_FILE`, as the recipes give them. How
  to change it is in [SECRETS.md](SECRETS.md).
- The server makes machines itself, as sandboxes, at the providers it was set up with. For
  Docker, set `ACENTRIC_DOCKER_HOST`, such as `unix:///var/run/docker.sock`, and
  `ACENTRIC_DOCKER_IMAGE` to the sandbox image of the server's version,
  `ghcr.io/acentricai/acentric-sandbox:0.20.0`. Whoever may make a sandbox then has the computer Docker is on. For
  Boat (boat.dev), build its snapshot with `deploy/sandbox/boat-template.sh` and set
  `ACENTRIC_BOAT_TEMPLATE` to the name it prints. An
  account at the provider is added with `POST /v1/providers`, and a sandbox is made with
  `POST /v1/sandboxes`: it is stopped when nothing was run on it for its idle time, and started
  again for the next command.
- A provider's models are called with a model account: a key of the provider's, added with
  `acentric accounts add` and checked with the provider before it is kept. No key is read from
  the environment. A ChatGPT account has no key: it is signed in with ChatGPT from the
  dashboard's Add account, as OpenAI's Sign in with ChatGPT has it, and its calls are made on
  that ChatGPT plan, its token renewed by the server. The first account of a provider is its
  default. An agent is of a provider; each actor is given an account of that provider when it
  is created, the one asked for or the default, and keeps it.
- Every call of a model is written down with what it used, cost and took. `GET /v1/usage` adds
  it up, by agent, actor, account, provider, model, day or hour (in a time zone asked for),
  failure, kind or version, and each of those by another. `GET /v1/usage/calls` lists the calls.
- Its API is described at `/v1/openapi.json`, and `@acentric/client` calls it.

Every setting is in [SETTINGS.md](SETTINGS.md).

## Using it

The `acentric` command is installed from your own server, so it is always the server's version.
It needs Node 24 or newer: where there is none, the script fetches Node from nodejs.org into
`~/.acentric`, for the command alone.

```sh
curl -fsSL http://localhost:4000/install-cli.sh | sh
acentric login                                 # asks for the API key the server printed
acentric init my-agents && cd my-agents        # a project with one agent
acentric deploy                                # bundles the agent and deploys it
acentric accounts add anthropic main           # the key its model is called with
acentric actors create my-agents               # a running agent
acentric actors send <actor> "Hello" --follow  # talk to it
```

When the server is upgraded, the command offers to update itself to the server's version the
next time it is used, and `acentric update` does it without asking.

[apps/cli/README.md](apps/cli/README.md) has every command.

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

None of these is published to npm: the server's image is what is released. A developer gets
the command and the machine program from their server, and `@acentric/agent` in each project
`acentric init` makes. The packages may change in any release.

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
