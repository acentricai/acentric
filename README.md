# Acentric

[![CI](https://github.com/acentricai/acentric/actions/workflows/ci.yml/badge.svg)](https://github.com/acentricai/acentric/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@acentric/types?label=npm)](https://www.npmjs.com/org/acentric)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A framework for writing AI agents as pure reducers with declared effects.**

An agent describes how it behaves: what it remembers, how it responds to each
message, and which effects it wants running. A runner executes it: in memory
for tests, on your machine with a store that survives restarts, or anywhere
else that follows the same contract.

```ts
import type { Agent, NoConfig } from '@acentric/types';

type Reminder = { key: string; text: string; at: number };
type Snapshot = { reminders: Reminder[] };
type Kinds = { '@timer': { args: { at: number }; result: null } };

const agent: Agent<Snapshot, NoConfig, Kinds> = {
  name: 'reminders',
  version: '0.1.0',

  init: () => ({ snapshot: { reminders: [] } }),

  // Pure: the next state, given one message. No network, files, clock or randomness.
  step: ({ snapshot }, message, now) => {
    if (message.type === 'input' && message.kind === 'remind') {
      const text = String(message.payload['text']);
      const at = now + Number(message.payload['inSeconds']) * 1000;
      return {
        snapshot: { reminders: [...snapshot.reminders, { key: `remind:${at}`, text, at }] },
      };
    }
    if (message.type === 'effect') {
      const reminder = snapshot.reminders.find((r) => r.key === message.key);
      return {
        snapshot: { reminders: snapshot.reminders.filter((r) => r.key !== message.key) },
        append: reminder === undefined ? [] : [{ kind: 'reminder', body: reminder.text }],
      };
    }
    return { snapshot };
  },

  // The effects the agent wants running now. The runner starts new ones and cancels dropped ones.
  effects: ({ snapshot }) =>
    snapshot.reminders.map((r) => ({ key: r.key, kind: '@timer', args: { at: r.at } })),
};

export default agent;
```

## Why

Most agent frameworks run a loop: call the model, run the tools, call the
model again. The loop's state lives in a paused function, so you cannot save
it, inspect it, test it without mocks, or move it to new code. Acentric keeps
that state as data and makes every decision a pure function of it:

- **Testing without mocks.** Feed `step` messages and check what it returns:
  no model, network or clock.
- **Effects you can see and cancel.** What should be running follows from the
  state; cancelling is just no longer declaring it.
- **One message at a time.** A stop or a steer that arrives mid-reply is just
  the next message.
- **Upgrading live sessions.** New code takes over a running session between
  two steps, which is also how hot reload works.
- **Same agent, any runner.** One bundle runs unchanged on every runner that
  passes the same conformance tests.
- **Replay.** Re-run what a session received, on the code that ran it or on
  new code, and see exactly where it differs.

It has costs too, and [What it costs](docs/why/costs.md) says when a plain loop
is the better choice.

## Quick start

You need Node.js 22.13 or later.

```bash
npm create acentric@latest my-agent
cd my-agent
npm run dev
```

This opens a dev runner and UI on `http://127.0.0.1:7420` that hot-reloads
your agent on save, keeping its sessions. [Getting started](docs/getting-started.md)
walks through the project, its tests, and running it for real.

## Documentation

The documentation is plain Markdown in [`docs/`](docs/README.md):

- [Getting started](docs/getting-started.md)
- [How an agent works](docs/concepts/README.md): state, messages, effects and
  handlers, the view, and runners
- [Why an agent is a reducer](docs/why/README.md): what you get, and what it
  costs
- [Runner specification](docs/reference/runner-spec.md): the contract every
  runner follows

Every TypeScript example in the docs is type-checked against the packages, and
the ones that prove a claim are run, on every change.

## Packages

| Package                                         | Version                                                                                                               | What it is                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`create-acentric`](packages/create-acentric)   | [![npm](https://img.shields.io/npm/v/create-acentric)](https://www.npmjs.com/package/create-acentric)                 | `npm create acentric`: a new project from a template                |
| [`@acentric/types`](packages/types)             | [![npm](https://img.shields.io/npm/v/@acentric/types)](https://www.npmjs.com/package/@acentric/types)                 | the types an agent is made of                                       |
| [`@acentric/testing`](packages/testing)         | [![npm](https://img.shields.io/npm/v/@acentric/testing)](https://www.npmjs.com/package/@acentric/testing)             | tests for an agent's pure half and its handlers, with no runner     |
| [`@acentric/cli`](packages/cli)                 | [![npm](https://img.shields.io/npm/v/@acentric/cli)](https://www.npmjs.com/package/@acentric/cli)                     | the `acentric` command: dev, build, start, inspect, replay and fork |
| [`@acentric/llm`](packages/llm)                 | [![npm](https://img.shields.io/npm/v/@acentric/llm)](https://www.npmjs.com/package/@acentric/llm)                     | calls Anthropic, OpenAI and Fireworks from handlers                 |
| [`@acentric/client`](packages/client)           | [![npm](https://img.shields.io/npm/v/@acentric/client)](https://www.npmjs.com/package/@acentric/client)               | talks to a runner from an application                               |
| [`@acentric/runner-local`](runners/local)       | [![npm](https://img.shields.io/npm/v/@acentric/runner-local)](https://www.npmjs.com/package/@acentric/runner-local)   | a runner for your machine or a single server                        |
| [`@acentric/runner-memory`](runners/memory)     | [![npm](https://img.shields.io/npm/v/@acentric/runner-memory)](https://www.npmjs.com/package/@acentric/runner-memory) | a runner in memory, for tests and scripts                           |
| [`@acentric/replay`](packages/replay)           | [![npm](https://img.shields.io/npm/v/@acentric/replay)](https://www.npmjs.com/package/@acentric/replay)               | replays a session's journal on the code that ran it, or new code    |
| [`@acentric/protocol`](packages/protocol)       | [![npm](https://img.shields.io/npm/v/@acentric/protocol)](https://www.npmjs.com/package/@acentric/protocol)           | the JSON-RPC protocol between applications and runners              |
| [`@acentric/conformance`](packages/conformance) | [![npm](https://img.shields.io/npm/v/@acentric/conformance)](https://www.npmjs.com/package/@acentric/conformance)     | the scenarios every runner must pass                                |

[`templates/composable-agent`](templates/composable-agent) is a work-in-progress
template for model-driven agents with tools, compaction and retries; it is not
published yet.

## Status

Acentric is early: every package is at 0.x, and APIs may change between minor
versions. The [changelog](CHANGELOG.md) records what changes, and the
[roadmap](docs/roadmap.md) what is set aside for later.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains
how to set up the repository, run the checks and propose a change. Please
follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues
as [SECURITY.md](SECURITY.md) describes, not in public issues.

## License

[Apache 2.0](LICENSE)
