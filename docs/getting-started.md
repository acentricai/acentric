# Getting started

_Create a project, run it with hot reload, test it, and run it for real._

## Before you start

You need [Node.js](https://nodejs.org) 22.13 or later. The local runner keeps
sessions in SQLite through `node:sqlite`, which needs no flag from 22.13 on.
Any of npm, pnpm, yarn or bun works.

## Create a project

```bash
npm create acentric@latest my-agent
cd my-agent
```

`create-acentric` asks for a folder and whether to install dependencies,
unless you pass them. See its [README](../packages/create-acentric/README.md)
for every option.

The project starts as a notes agent with reminders, so it runs with no API
key:

| File                 | Holds                                                       |
| -------------------- | ----------------------------------------------------------- |
| `src/agent.ts`       | the pure half: what the agent remembers and how it responds |
| `src/handlers.ts`    | the handlers: where I/O goes, such as calling a model       |
| `test/agent.test.ts` | tests of the pure half, with no runner                      |
| `acentric.config.ts` | the project's agents, and where `start` keeps them          |

## Run it

```bash
npm run dev
```

This starts a dev runner and a dev UI on `http://127.0.0.1:7420`. Open it,
create a session of `notes`, and send it inputs:

| Kind     | Payload                        |
| -------- | ------------------------------ |
| `add`    | `{ "text": "buy milk" }`       |
| `done`   | `{ "id": 1 }`                  |
| `remind` | `{ "id": 1, "inSeconds": 10 }` |

Each input is a message to the agent's `step`. `add` and `done` change the
snapshot and append to the log. `remind` makes the agent declare a `@timer`
effect; the runner starts it, and when it fires its result arrives as the
next message, which logs the reminder.

Now edit `src/agent.ts` and save. Hot reload is an upgrade: the session moves
to your new code between two steps and keeps its notes. An effect running
during the save keeps running, and the new code handles its result. A
session that failed on a bug is fixed by saving the fix.

## Test it

```bash
npm test
```

The tests drive the pure half with `simulate` from `@acentric/testing`:
there is no runner, no clock and no network. A test sends inputs, reports
effect outcomes by hand and checks what `step` returned:

```ts
const sim = simulate(agent, {});
sim.input('add', { text: 'buy milk' });
const remind = sim.input('remind', { id: 1, inSeconds: 30 });
expect(remind.started).toEqual([
  { key: 'remind:1:30000', kind: '@timer', args: { at: 30000 } },
]);

sim.advance(30_000);
sim.ok('remind:1:30000', null);
expect(sim.log.at(-1)).toMatchObject({
  kind: 'reminder',
  body: { id: 1, text: 'buy milk' },
});
```

[Testing without mocks](why/testing.md) explains why this works.

## Build and run it for real

```bash
npm run build   # type-check, bundle, check the pure half is pure
npm start       # a local runner on ws://127.0.0.1:7420
```

`build` writes each agent's bundle to `.acentric/build`. `start` runs the
local runner on those bundles and keeps sessions in
`.acentric/store.db`, so they survive restarts. Talk to it from the
[CLI](../packages/cli/README.md#inspecting-a-runner):

```bash
npx acentric create notes@0.1.0
npx acentric send <id> add '{"text": "buy milk"}'
npx acentric log <id> -f
```

or from your application with [@acentric/client](../packages/client).

## Add your own I/O

Anything that touches the world, such as calling a model, is an effect. The
agent declares it; a handler in `src/handlers.ts` runs it. Secrets such as API
keys go in a `.env` file and are named under `secrets` in
`acentric.config.ts`:

```ts
export default defineConfig({
  agents: {
    notes: { agent: 'src/agent.ts', handlers: 'src/handlers.ts' },
  },
  secrets: ['ANTHROPIC_API_KEY'],
});
```

[Effects and handlers](concepts/effects.md) walks through a chat agent that
streams a model's reply, and [@acentric/llm](../packages/llm) calls Anthropic,
OpenAI and Fireworks from a handler.

## Next

- [How an agent works](concepts/README.md): the whole model in one page.
- [Why an agent is a reducer](why/README.md): what you get for writing it this
  way, and what it costs.
