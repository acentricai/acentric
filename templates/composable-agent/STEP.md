# Step

How the template's step handles every message in every phase, and the
contracts its parts meet to make that work. It follows the pi and meals
agents' loops, with what differs between agents moved into parts. Types are
in [src/loop](src/loop), [src/tools](src/tools), [src/compaction](src/compaction),
[src/retry](src/retry) and [src/inputs](src/inputs).

## Phases

| Phase           | Meaning                                                       | Owned by   |
| --------------- | ------------------------------------------------------------- | ---------- |
| `idle`          | no turn going                                                 | loop       |
| `calling_model` | a model call is running                                       | loop       |
| `running_tools` | the latest reply's tool calls are running                     | tools      |
| `waiting_retry` | waiting on a timer to call the model again after a failure    | retry      |
| `compacting`    | summarising older history, then calling the model or stopping | compaction |

A turn starts with a message and ends when the model stops calling tools,
the turn is interrupted, or a failure ends it. `turn` is set for its length.
Compaction can also run with no turn, after one ends.

## Every message in every phase

| Message         | `idle`     | `calling_model` | `running_tools`   | `waiting_retry` | `compacting`             |
| --------------- | ---------- | --------------- | ----------------- | --------------- | ------------------------ |
| message input   | start turn | wait            | wait              | wait            | wait                     |
| `interrupt`     | clear      | stop: abort     | stop: abort       | stop: end turn  | stop: end turn, or clear |
| other input     | per input  | per input       | per input         | per input       | per input                |
| `config`        | check      | check           | check             | check           | check                    |
| `llm` result    | ignore     | the reply       | ignore            | ignore          | ignore                   |
| a tool's result | ignore     | ignore          | the tool's result | ignore          | ignore                   |
| `@timer`        | custom     | custom          | custom            | call the model  | custom                   |
| `summarize`     | ignore     | ignore          | ignore            | ignore          | the summary              |
| `migrated`      | nothing    | nothing         | nothing           | nothing         | nothing                  |

A result is taken only when its key is one the phase is waiting on. A result
with a key the custom part owns goes to it, in any phase; any other is
ignored.

Every step works from the settings its state's config gives. The config was
checked when it was accepted, so it always gives settings, unless a new
version of the code checks it differently; then the step fails, and the
runner stops the session for someone to look at.

## Procedures

Every message's handling is made of these.

**Start a turn** with some user messages: set `turn` to
`{ startedAt: now, modelCalls: 0, stopping: false }`, `retries` to 0 and
`overflowCompacted` to false; tell the custom part a turn started; append
each message as a `user` entry; continue.

**Continue**: ask the compaction part whether to compact before the model's
next call. If it says so, start compacting (threshold, then continue).
Otherwise call the model.

**Call the model**:

1. Give the model the steering messages: append each one waiting in
   `steering` as a `user` entry, oldest first, copied from its `queued`
   entry, and empty `steering`. This is the one place steering is
   delivered, so a steer always reaches the model at its next call.
2. If `turn.modelCalls` has reached the limit, append a notice and end the
   turn.
3. Take a new key, `llm:<n>`, and fix the call's args: the model and
   thinking from the settings, the context the compaction part gives (up to
   the end of the log), the prompt args, and the names of the tools offered.
   Add 1 to `turn.modelCalls` and enter `calling_model`.

**Start the tools** of the reply at `replySeq`. For each pending call, in
the order the model made them:

- an unknown tool, arguments that are not JSON, or arguments that fail the
  tool's parameters get an error result at once;
- otherwise the tool's `prepare` runs: an `answer` is appended as the
  call's result at once; a `run` adds the call as `waiting`, with a new key
  `tool:<n>` and the `extra` it passes on. Either may replace the tools
  part of the snapshot.

Then start what may run. If no call waits, every call was answered at once:
continue.

**Start what may run**: walking the calls in order, a waiting call becomes
`running` unless a call before it is unfinished and either is `sequential`,
or a call before it with the same `resourceKey` is unfinished. Parallel
calls with no resource key all start together. Nothing starts once the turn
is stopping.

**End the turn**:

1. If steering messages are waiting and the turn is not stopping, the turn
   goes on with them: continue.
2. Otherwise, if messages are waiting, a new turn starts with all of them:
   the steering ones, then the queued ones, oldest first. Steering messages
   are only waiting here if they arrived after an interrupt, while the
   stopped turn's effects were still reporting: they start a fresh turn
   rather than continue the stopped one.
3. Otherwise ask the compaction part whether to compact now. If it says so,
   start compacting (threshold, not continuing), with no turn.
4. Otherwise go idle: `turn` is null. Tell the custom part the agent went
   idle.

**Stop**: set `turn.stopping`; empty `steering` and `queued`, appending a
notice if that dropped any. Effects of a stopping turn are declared with
`abort: true`, so running handlers get their signal and still report.

## A message

A message input (one whose definition has `role: 'message'`) is checked and
read into a user message and its delivery; a payload that fails its schema
is rejected and changes nothing.

- **Idle**: start a turn with it.
- **Busy, in a turn**: append it as a `queued` entry, and add its seq to
  `steering` if its delivery, or else the settings' default delivery, is
  `steer`, or to `queued` if `queue`.
- **Busy, compacting with no turn**: append it as a `queued` entry and add
  its seq to `queued`, whatever its delivery: there is no turn to steer, so
  it starts the next one.

## Interrupt

Always accepted. Stopping keeps what already happened: the reply and tool
results so far stay in the log.

| Phase                      | Then                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `idle`                     | empty `steering` and `queued`                                                   |
| `calling_model`            | stop; the call is aborted, and its result ends the turn                         |
| `running_tools`            | stop; running calls are aborted, and the turn ends when they have all reported  |
| `waiting_retry`            | stop; end the turn now, which cancels the timer                                 |
| `compacting`, in a turn    | stop; the summary finishes, since the session needs it, and the turn then ends  |
| `compacting`, with no turn | empty `steering` and `queued`; the summary goes on, since it was not the user's |

## Config

Checked as at creation, with readSettings: an invalid config is rejected and
changes nothing. An accepted one applies from the model's next call: a call
already running keeps the args it started with.

## A reply

When the `llm` effect returns, the reply is appended as an `assistant` entry,
its usage is added to `totals`, and `retries` goes back to 0. If the turn is
stopping, its pending calls get an error result saying they were not run, and
the turn ends. Otherwise:

| The reply                                 | Then                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| has pending tool calls, stopped by length | each call gets an error result: it was cut off; continue |
| has pending tool calls                    | start the tools                                          |
| stopped with `pause_turn`                 | call the model again                                     |
| anything else                             | end the turn                                             |

When it fails, `llmFailure` reads the failure. Then:

| The failure                                         | Then                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| the turn is stopping                                | end the turn                                                                       |
| `context_overflow`, not yet compacted this turn     | `model_error`; set `overflowCompacted`; start compacting (overflow, then continue) |
| one the retry part says to retry, with retries left | `model_error`, retrying; `retries` + 1; wait until the time the retry part gives   |
| anything else                                       | `model_error`, not retrying; end the turn                                          |

The retry part retries a failure that is `retryable`, and a runner timeout.
It waits `min(max(baseDelayMs × 2^(retries − 1), retryAfterMs), maxDelayMs)`.

Failures are never shown to the model: `model_error` is not part of what it
sees.

## A tool's result

The call is marked done. What the model reads comes from the tool:

- a result: its `result`, or the result itself if it is a ToolOutput, or
  else the result as JSON;
- a failure, or `interrupted` for a `once` call cut off by a crash: its
  `unfinished`, or a sentence describing what happened.

Either hook may replace the tools part of the snapshot. The output is
appended as a `tool_result` entry, made with `toolResult` from the call in
the reply. Then start what may run. When no call is running any more: if
the turn is stopping, calls that never started get an error result saying
they were not run, and the turn ends; otherwise every call is done:
continue.

Results are appended in the order calls finish. What the model sees puts
them back in the order of the reply's calls.

## The retry timer

In `waiting_retry`, when its timer fires: call the model.

## A summary

When `summarize` returns, the compaction part appends a `compaction` entry
and moves its pointer, so the window and what the model sees start from the
first kept entry. The summary's usage is added to `totals`. Then call the
model if continuing and the turn is not stopping, or else end the turn (with
no turn, the end of a turn goes idle or starts the next one).

If it fails, a notice says so. A threshold compaction that was continuing
calls the model anyway, since the context still fits. An overflow
compaction cannot: `model_error`, end the turn. One that was not continuing
ends the turn.

## Effects

Read straight from the phase. Every key is single-use.

| Phase           | Effects                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `idle`          | none                                                                                           |
| `calling_model` | `llm` with its args; `abort` once the turn is stopping                                         |
| `running_tools` | `tool:<name>` for each running call, with `{ replySeq, callId, extra }`; `abort` once stopping |
| `waiting_retry` | `@timer` at the retry time                                                                     |
| `compacting`    | `summarize`, with the range the compaction part gives                                          |

The custom part declares its own effects beside these, in any phase.

## The contracts this needs

The table runs through each part only at these points.

**Compaction**, for a strategy that summarises and for one that does nothing:

| Hook                                     | Summarise                                                      | None             |
| ---------------------------------------- | -------------------------------------------------------------- | ---------------- |
| `beforeModelCall(state, settings)`       | compact if the estimated context is over the threshold         | never            |
| `afterTurn(state, settings)`             | the same, to compact while idle                                | never            |
| `onOverflow(state)`                      | compact, once a turn                                           | give up          |
| `start(draft, reason, thenContinue)`     | find the cut point; enter `compacting`                         | not called       |
| `settle(draft, outcome)`                 | append the summary and move the pointer                        | not called       |
| `effects(state, settings)`               | `summarize` while compacting                                   | none             |
| `contextRefs(state, toSeq)`              | the latest summary, then the entries from its first kept entry | everything       |
| `window(state)`                          | the latest compaction's first kept entry                       | 1                |
| `context(entries, refs)`, in the handler | the summary as a user message, then the conversation           | the conversation |

**Tools**: the contract in [src/tools/define.ts](src/tools/define.ts), plus
starting what may run, above.

**Retry**: `shouldRetry(failure, retries, settings)` and
`retryAt(now, retries, failure, settings)`.

**Inputs**: `readInput`, and the settings' default delivery.

**Custom**: told when a turn starts and when the agent goes idle; owns the
results of effects whose keys it made; declares effects of its own. Meals'
cache warming is one: it starts a timer when the agent goes idle and drops
it when a turn starts.

**A working copy per step**: step opens one holding the snapshot, the
entries to append, the settings, the window and `now`. Each part changes it
through it: appending an entry returns the seq it will get, and a new key
comes from `nextKey`. Step returns what it holds at the end.

## Open

- The limit on model calls per turn: a constant for now (meals stopped at 25,
  the factory at 200), or a config field.
- Images in messages, and in tool results, which the model sees for a few
  turns only (meals kept the newest few).
- View: what callers and UIs see of a session.
