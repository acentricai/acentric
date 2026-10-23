# {{name}}

An agent built with [acentric](https://github.com/acentricai/acentric): a
pure half that decides, and handlers that do the I/O.

It starts as a notes agent with reminders, so it runs with no API key.

| File                 | Holds                                                       |
| -------------------- | ----------------------------------------------------------- |
| `src/agent.ts`       | the pure half: what the agent remembers and how it responds |
| `src/handlers.ts`    | the handlers: where I/O goes, such as calling a model       |
| `test/agent.test.ts` | tests of the pure half, with no runner                      |
| `acentric.config.ts` | the project's agents, and where `start` keeps them          |

## Run it

```bash
{{run}} dev
```

Open the dev UI it prints, create an instance of `notes`, and send it inputs:

| Kind     | Payload                        |
| -------- | ------------------------------ |
| `add`    | `{ "text": "buy milk" }`       |
| `done`   | `{ "id": 1 }`                  |
| `remind` | `{ "id": 1, "inSeconds": 10 }` |

Edit `src/agent.ts` and save: the instance reloads with your change and keeps
its notes.

## Commands

| Command             | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `{{run}} dev`       | a dev runner and UI that reload on save                 |
| `{{run}} test`      | the tests                                               |
| `{{run}} typecheck` | type-checks the project                                 |
| `{{run}} build`     | bundles the agent into `.acentric/build`                |
| `{{run}} start`     | runs the built agent, keeping instances across restarts |

Secrets for handlers, such as API keys, go in a `.env` file and are named
under `secrets` in `acentric.config.ts`.
