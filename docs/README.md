# Acentric documentation

Acentric is an experimental framework for writing agents as pure reducers. An
agent describes how it behaves: what it remembers, how it responds to each
message, and which effects it wants running. A runner executes it: in memory for
tests, on your machine with a store that survives restarts, or anywhere else
that follows the same contract.

New here? Start with [Getting started](getting-started.md), then read
[How an agent works](concepts/README.md).

## Get started

- [Getting started](getting-started.md): create a project, run it with hot
  reload, test it, and run it for real.

## Concepts

- [How an agent works](concepts/README.md): an agent describes how it
  behaves; a runner runs it.
- [State](concepts/state.md): what a session keeps: a small snapshot, a log
  written once, and its config.
- [Messages](concepts/messages.md): everything that happens to a session
  reaches `step` as one of four messages.
- [Effects and handlers](concepts/effects.md): an agent declares the effects
  it wants running; handlers do the I/O.
- [The view](concepts/view.md): what callers see of a session, apart from what
  the agent keeps.
- [Runners](concepts/runners.md): what every runner promises, and what each
  one chooses.

## Why reducers

- [Why an agent is a reducer](why/README.md): a loop keeps its state in a
  paused function; a reducer's state is data.
- [Testing without mocks](why/testing.md)
- [Effects you can see and cancel](why/effects.md)
- [One message at a time](why/one-at-a-time.md)
- [Upgrading live sessions](why/upgrades.md)
- [Same agent, any runner](why/portability.md)
- [Replaying a session](why/replay.md)
- [What it costs](why/costs.md): and when a plain loop is the better choice.

## Packages

Each package's README is its reference.

| Package                                            | What it is                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| [`create-acentric`](../packages/create-acentric)   | `npm create acentric`: a new project from a template                |
| [`@acentric/types`](../packages/types)             | the types an agent is made of                                       |
| [`@acentric/testing`](../packages/testing)         | tests for an agent's pure half and its handlers, with no runner     |
| [`@acentric/cli`](../packages/cli)                 | the `acentric` command: dev, build, start, inspect, replay and fork |
| [`@acentric/llm`](../packages/llm)                 | calls Anthropic, OpenAI and Fireworks from handlers                 |
| [`@acentric/client`](../packages/client)           | talks to a runner from an application                               |
| [`@acentric/runner-local`](../runners/local)       | a runner for your machine or a single server                        |
| [`@acentric/runner-memory`](../runners/memory)     | a runner in memory, for tests and scripts                           |
| [`@acentric/replay`](../packages/replay)           | replays a session's journal on the code that ran it, or new code    |
| [`@acentric/protocol`](../packages/protocol)       | the JSON-RPC protocol between applications and runners              |
| [`@acentric/conformance`](../packages/conformance) | the scenarios every runner must pass                                |

## Reference

- [Runner specification](reference/runner-spec.md): the contract every runner
  follows, so the same agent behaves the same on all of them.
- [The local runner](reference/local-runner.md): the design of
  `@acentric/runner-local`, its stores, protocol and handler hosts.
- [Replay and forks](reference/replay.md): the design of the journal, replay
  and forking sessions.
- [Roadmap](roadmap.md): questions and features set aside for later.
