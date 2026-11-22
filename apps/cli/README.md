# acentric

The command for building agents against an engine: sign in to it, start a project, deploy, and
run what was deployed.

```sh
curl -fsSL https://<engine>/install-cli.sh | sh   # installs it from your engine
acentric login                                    # asks for an API key of that engine
acentric init my-agents                           # a project with one agent
cd my-agents && acentric deploy                   # bundles each agent and deploys it
acentric accounts add anthropic main              # the key its model is called with
acentric actors create my-agents                  # a running agent
acentric actors send <actor> "Hello" --follow     # talk to it
```

## A project

| Command                                               | What it does                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acentric login [engine] [--key <key>]`               | Checks the key with the engine and keeps both in `~/.config/acentric/credentials.json`, a private file. With no address, the engine it was installed from.                                        |
| `acentric logout`                                     | Forgets the key here. The key works until it is revoked.                                                                                                                                          |
| `acentric whoami`                                     | The engine, and what the key reaches and may do.                                                                                                                                                  |
| `acentric init [dir] [--agent <name>] [--no-install]` | A project: `acentric.json`, `agents/<name>.ts`, `package.json`, `tsconfig.json`, and the agent package in `vendor/agent`. Then it installs its packages with the package manager the folder uses. |
| `acentric add <name> [--file <path>]`                 | Another agent, in `agents/<name>.ts` or the file given (from where the command runs).                                                                                                             |
| `acentric deploy [<name>...] [--dry-run]`             | Bundles each agent (or those named) and sends it to the engine: a new version when the code changed, `unchanged` when not. It says which secrets the code reads that are not set.                 |

`ENGINE_URL` and `ENGINE_API_KEY`, when both are set, are used in place of what `login` kept,
as in CI.

`acentric.json` maps each agent's name to its file, from the folder it is in. It is found by
looking up from where a command runs, so the agents of a monorepo can be anywhere in it:

```json
{ "agents": { "support": "agents/support.ts", "reviewer": "packages/review/agent.ts" } }
```

An agent is bundled with the project's own esbuild into one ES module for no particular
platform. It may use what every JavaScript runtime has, such as `fetch`. An import of a Node
module fails at `deploy`, saying where it is.

The agent package is not published yet. `init` puts a copy in `vendor/agent`, with its types,
and the project depends on it as `file:./vendor/agent`.

## A running engine

| Command                                                                                                                                | What it does                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acentric accounts`                                                                                                                    | The model accounts of the engine: what each provider's models are called with. Never their keys.                                                                           |
| `acentric accounts add <provider> <name> [--key <key>] [--default]`                                                                    | Adds one. The key is asked for, or read from what is piped in. The engine checks it with the provider and keeps it sealed. The first account of a provider is its default. |
| `acentric accounts remove <name>`                                                                                                      | Removes one that no agent is given.                                                                                                                                        |
| `acentric secrets <agent>`                                                                                                             | The names of an agent's secrets. Never their values.                                                                                                                       |
| `acentric secrets set <agent> <NAME> [--value <value>]`                                                                                | Sets one, in place of what it was. The value is asked for, or read from what is piped in.                                                                                  |
| `acentric secrets remove <agent> <NAME>`                                                                                               | Removes one.                                                                                                                                                               |
| `acentric actors [--agent <agent>]`                                                                                                    | The actors of the engine, or of one agent.                                                                                                                                 |
| `acentric actors create <agent> [--name <name>] [--external-id <id>] [--model <model>] [--reasoning <level>] [--configuration <json>]` | Makes an actor of an agent.                                                                                                                                                |
| `acentric actors send <actor> <text> [--follow]`                                                                                       | Sends an actor a message. With `--follow`, prints what it does until its turn has ended.                                                                                   |
| `acentric actors send <actor> --type <type> --payload <json> [--follow]`                                                               | Sends an input of another type, as the agent takes it.                                                                                                                     |
| `acentric actors logs <actor> [--follow]`                                                                                              | An actor's conversation. With `--follow`, goes on printing it as it grows.                                                                                                 |

An agent is named by its name. An actor is named by its ID, or as `<agent>/<name>` when it has
a name.

## Its own version

The command is installed from an engine, and is that engine's own build of it. It stays so:

| Command            | What it does                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `acentric version` | This command's version, the engine's, and whether the engine hands out this version of the command. |
| `acentric update`  | Takes the version the engine hands out, without asking.                                             |

Every answer of an engine says which command it hands out. When that is not the one you have,
the command asks, after it has done what you asked for, whether to update to it. Say no, and
it does not ask again until the engine has yet another version. It asks only when a person is
there to answer: in a script or in CI it says nothing, and `acentric update` is run when wanted.

The engine's version is the one to have, whichever is newer. With two engines of different
versions, the command is updated to the one it is used with.

## Building

`pnpm build`, at the root of the repository, makes `dist/acentric.mjs`: the command as one
file. A server that is told its folder (`ACENTRIC_DOWNLOADS`) hands it out at `/acentric.mjs`,
with `install.sh` as `/install-cli.sh`. The server's image does.

Before that, `scripts/vendor.ts` makes `src/vendored.ts`, the agent package as `init` writes
it, from `packages/agent` and `packages/protocol`.
