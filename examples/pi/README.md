# pi coding agent

[pi](https://github.com/badlogic/pi-mono)'s original coding agent, rebuilt as
an acentric agent: a pure reducer that decides, with handlers that do the I/O.
It reproduces pi's default harness, not pi durable.

## Scope

In:

- the run loop: prompt, model call, tool calls, model call again, until the
  model stops calling tools
- the four default tools: `read`, `bash`, `edit`, `write`
- steering and follow-up messages
- abort, keeping the partial reply
- retrying failed model calls with backoff
- compaction: summarising older history as the context fills
- pi's fixed default system prompt
- model and thinking level changes, from a bundled model catalog
- images, in user messages and from `read`, without resizing

Out, for now:

- `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md` and `CLAUDE.md` files
- branching sessions (`/tree`, `/fork`)
- extensions and hooks, skills, prompt templates, `!` bash shortcuts
- the terminal UI
- `pause` and `resume`, which this agent rejects

## How pi maps onto the framework

| pi                                                           | Here                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| transcript messages, model and thinking changes, compactions | log entries                                                      |
| current model, the run's phase, queued messages, retries     | snapshot                                                         |
| cwd, default model, compaction and retry settings            | config                                                           |
| prompt, steer, follow-up, `/model`, `/thinking`, `/compact`  | inputs                                                           |
| the model call                                               | the `llm` effect, streaming with `emit`, stopped with `abort`    |
| the four tools                                               | effects, one per tool call                                       |
| compaction's summary call                                    | the `summarize` effect                                           |
| backoff before a retry                                       | the runner's `@timer`                                            |
| parallel tool calls                                          | several effects at once; step waits for the batch                |
| the model catalog                                            | code bundled with the agent, read by step                        |
| token estimates, cut points, retryable errors                | pure logic in step                                               |
| edits to one file running one at a time                      | step declares the next edit to a file once the previous finished |

## Config

See [src/config.ts](src/config.ts). Only `cwd` and `model` are required.
Init fills in the defaults and keeps the result in the snapshot as
`settings`, so step never handles a missing field. Init rejects a model that
is not in the catalog.

| Field                          | Default                                  |
| ------------------------------ | ---------------------------------------- |
| `cwd`                          | required                                 |
| `model`                        | required                                 |
| `thinkingLevel`                | `medium`                                 |
| `compaction`                   | enabled, 16384 reserved, 20000 kept      |
| `retry`                        | enabled, 3 retries, 2 s doubling to 60 s |
| `steeringMode`, `followUpMode` | `one-at-a-time`                          |

## State

The snapshot is rewritten on every step, so it holds only control state,
settings and small indexes into the log. Everything large goes in the log,
which is written once.

**Log entries** ([src/log.ts](src/log.ts)):

| Kind              | Holds                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| `user`            | a user message the model sees                                               |
| `queued`          | a steer or follow-up message waiting for its turn; the model doesn't see it |
| `assistant`       | a model reply, including failed and aborted ones                            |
| `tool_result`     | one tool call's result                                                      |
| `model_change`    | the model changed                                                           |
| `thinking_change` | the thinking level changed                                                  |
| `compaction`      | a summary of older history, and the first entry kept                        |
| `omit`            | an entry the model should no longer see, such as a failed attempt           |
| `notice`          | something for UIs to show, such as a retry; the model doesn't see it        |

What the model sees is built by one pure function, shared by step and the
`llm` handler: the system prompt, the latest compaction's summary, then the
`user`, `assistant` and `tool_result` entries from the first kept entry, minus
omitted ones.

**Snapshot** ([src/snapshot.ts](src/snapshot.ts)): the resolved settings, the
current model and thinking level, the run's phase, the seqs of queued
messages, the retry count, whether an overflow was already compacted for the
current prompt, the latest compaction, and a counter for effect keys. The
context size is estimated from the log when step needs it, so it never goes
stale.

**Phases:**

| Phase           | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `idle`          | no run going                                                   |
| `calling_llm`   | a model call is running                                        |
| `running_tools` | the reply's tool calls are running                             |
| `waiting_retry` | waiting to retry a failed model call                           |
| `compacting`    | summarising older history, then carrying on if a run was going |

**Window:** a step sees the log from the latest compaction's first kept
entry, or from the oldest queued message if that is older. When a queued
message's turn comes, step appends it again as a `user` entry.

How step handles every message in every phase is in [STEP.md](STEP.md).

## Inputs

See [src/inputs.ts](src/inputs.ts).

| Kind           | Payload             | Step                                                                   |
| -------------- | ------------------- | ---------------------------------------------------------------------- |
| `prompt`       | `{ text, images? }` | Starts a run. Rejected while one is going, as in pi                    |
| `steer`        | `{ text, images? }` | Queued; given to the model after the current tool calls                |
| `follow_up`    | `{ text, images? }` | Queued; given to the model when the run would otherwise end            |
| `abort`        | `{}`                | Stops the model call and tools, keeps the partial reply, clears queues |
| `set_model`    | `{ provider, id }`  | Applies from the next model call; rejected if not in the catalog       |
| `set_thinking` | `{ level }`         | Applies from the next model call                                       |
| `compact`      | `{ instructions? }` | Summarises older history now                                           |

## Effects

See [src/kinds.ts](src/kinds.ts). Args reference data in the log rather than
copy it: the conversation and tool arguments are already there, and copying
them into every call would grow with every turn.

| Kind        | Mode    | Args                                  | Result                        |
| ----------- | ------- | ------------------------------------- | ----------------------------- |
| `llm`       | reissue | model, thinking level, cwd, log range | the assistant message         |
| `read`      | reissue | the tool call's log entry and id, cwd | tool result                   |
| `bash`      | once    | the tool call's log entry and id, cwd | tool result                   |
| `edit`      | once    | the tool call's log entry and id, cwd | tool result                   |
| `write`     | reissue | the tool call's log entry and id, cwd | tool result                   |
| `summarize` | reissue | model, log range, previous summary    | summary text and usage        |
| `@timer`    | runner  | `{ at }`                              | fires after a retry's backoff |

API keys come from the handler's secrets, never from args.

## Code and tests

The pure half is in [src](src): `agent.ts` puts it together from `step.ts`,
`effects.ts`, the context projection (`context.ts`), token estimates
(`tokens.ts`), the compaction cut (`cut.ts`), error rules (`errors.ts`), the
tools' schemas and argument checks (`tools.ts`), the system prompt
(`prompt.ts`) and the model catalog (`catalog.ts`). It imports nothing but
typebox. Handlers come next.

The tests in [test](test) drive the pure half through `@acentric/testing`'s
simulator, playing the model and the tools by hand.

```bash
pnpm test
```
