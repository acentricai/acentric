# Step

How the pi agent's step handles every message in every phase. Types are in
[src/snapshot.ts](src/snapshot.ts) and [src/log.ts](src/log.ts); the README
covers the state as a whole.

## Phases

| Phase           | Meaning                                        |
| --------------- | ---------------------------------------------- |
| `idle`          | no run going                                   |
| `calling_llm`   | a model call is running                        |
| `running_tools` | the tool calls of the latest reply are running |
| `waiting_retry` | waiting to retry a failed model call           |
| `compacting`    | summarising older history                      |

`calling_llm` and `running_tools` carry `aborting`: null while the run goes
on, or what follows once everything being stopped has reported.

## Shorthands

- **queue**: append a `queued` entry and add its seq to `steering` or
  `followUps`.
- **reject**: refuse it; the caller gets the reason and nothing changes.
- **ignore**: accept it and change nothing. Used for an effect result that no
  longer matters; it should not happen, but rejecting an effect result would
  be a bug.
- **inject**: read a `queued` entry, append it as a `user` entry, and remove
  its seq from its queue. `one-at-a-time` mode injects the oldest; `all`
  injects every one in order.
- **over the threshold**: compaction is enabled and the estimated context
  size is above the model's context window minus `reserveTokens`.
- **continue the run**: if over the threshold, compact (threshold, then
  continue); otherwise call the model. Every model call in a run goes through
  this, except the call straight after a compaction or a retry's timer.

## Every message in every phase

| Message            | `idle`           | `calling_llm`               | `running_tools`             | `waiting_retry`                      | `compacting`                           |
| ------------------ | ---------------- | --------------------------- | --------------------------- | ------------------------------------ | -------------------------------------- |
| `prompt`           | start a run      | reject: busy                | reject: busy                | reject: busy                         | reject: busy                           |
| `steer`            | as `prompt`      | queue                       | queue                       | queue                                | queue                                  |
| `follow_up`        | as `prompt`      | queue                       | queue                       | queue                                | queue                                  |
| `abort`            | nothing          | abort the run               | abort the run               | drop the timer, clear queues, `idle` | drop the summary, clear queues, `idle` |
| `compact`          | compact          | abort the run, then compact | abort the run, then compact | drop the timer, compact              | reject: compacting                     |
| `set_model`        | apply            | apply                       | apply                       | apply                                | apply                                  |
| `set_thinking`     | apply            | apply                       | apply                       | apply                                | apply                                  |
| `config`           | resolve settings | resolve settings            | resolve settings            | resolve settings                     | resolve settings                       |
| `migrated`         | nothing          | nothing                     | nothing                     | nothing                              | nothing                                |
| any other input    | reject           | reject                      | reject                      | reject                               | reject                                 |
| `llm` result       | ignore           | the reply                   | ignore                      | ignore                               | ignore                                 |
| a tool's result    | ignore           | ignore                      | the tool's result           | ignore                               | ignore                                 |
| `@timer` fired     | ignore           | ignore                      | ignore                      | call the model again                 | ignore                                 |
| `summarize` result | ignore           | ignore                      | ignore                      | ignore                               | the summary                            |

The sections below describe each non-trivial cell.

## Inputs in any phase

- **`set_model`**: rejected if the model is not in the catalog. Otherwise
  append `model_change` and update the snapshot. It applies from the next
  model call, including a retry.
- **`set_thinking`**: append `thinking_change` and update the snapshot. A
  model without reasoning uses `off`.
- **`config`**: resolve `settings` from the new config again.
- **Payloads**: an input whose payload does not have its kind's shape is
  rejected.

## Starting a run

A `prompt`, or a `steer` or `follow_up` while idle:

1. Append a `user` entry; reset `overflowRecovered` and `retries`.
2. Continue the run.

The new message is never summarised: it is the newest entry when compaction
starts, and compaction always keeps the newest entry.

## Calling the model

Calling the model takes a new key and records the model and thinking level
it uses and `toSeq`, the end of the conversation it is given. The `llm` args
name the latest compaction and the range of entries to read.

When the reply arrives, append it as an `assistant` entry. Then:

| The reply                                         | Then                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| was aborted, or the run is aborting               | every tool call it made gets an "aborted" `tool_result`; then what `aborting` says                                            |
| has tool calls, and stopped for them              | reset `retries`; run the tools                                                                                                |
| hit the output limit with tool calls              | reset `retries`; every call gets an error result ("not run: the reply hit the output token limit"); then as when tools finish |
| has no tool calls                                 | reset `retries`; end of turn                                                                                                  |
| failed with a context overflow, not yet recovered | append `omit` for it, set `overflowRecovered`; compact (overflow, then continue)                                              |
| failed with a retryable error, retries left       | append `omit` for it and a `notice`; `retries` + 1; wait until `now + min(baseDelayMs × 2^(retries − 1), maxDelayMs)`         |
| failed otherwise                                  | the error stays in the log; end of turn                                                                                       |

Retryable errors are overload, rate limit, server errors, network errors and
timeouts, as pi's `isRetryableAssistantError` decides them, and never a
context overflow. If the `llm` effect itself fails (its handler threw or
timed out) rather than returning a failed reply, step appends an `assistant`
entry with `stopReason: 'error'` and the failure's text, and the same rules
apply.

## Running tools

For each tool call in the reply, in order:

- An unknown tool gets an error result at once: `Tool X not found`.
- Arguments that fail the tool's schema get an error result at once, with the
  validation error. Malformed arguments from the model fail the same way.
- An `edit` or `write` to a path an earlier `edit` or `write` in the same
  reply also changes waits until that one is done.
- Every other call starts at once, with its own key.

A call that got an error result at once is done. The model sees these errors
on its next call and usually corrects itself, as in pi.

When a tool's result arrives:

| Outcome       | Append                                                          |
| ------------- | --------------------------------------------------------------- |
| `ok`          | its `tool_result`                                               |
| `failed`      | an error `tool_result` with the failure's text                  |
| `interrupted` | an error `tool_result`: interrupted, it may or may not have run |

Then mark the call done and start any waiting calls no longer blocked. When
every call is done:

- if aborting, do what `aborting` says;
- otherwise inject steering, then continue the run.

Results are appended in the order they finish. The projection puts them in
the order the reply made the calls, so a provider always sees each result
after its call and in that order.

## End of turn

The model stopped without calling tools, or failed for good:

1. If steering is queued, inject it and continue the run.
2. Otherwise, if follow-ups are queued, inject them and continue the run.
3. Otherwise, if over the threshold, compact (threshold, not continuing).
4. Otherwise go idle.

## Abort

Aborting clears the queues and stops what is running. Messages queued after
the abort wait for the next run.

- `calling_llm`: set `aborting`; the call is marked `abort`, and its partial
  reply arrives as aborted.
- `running_tools`: set `aborting`; every running call is marked `abort` and
  returns what it had, such as a command's output so far. Waiting calls get
  an "aborted" result at once.
- `waiting_retry` and `compacting`: drop the timer or the summary, then go
  idle.

While aborting, another `abort` does nothing and `prompt` is still rejected.
When everything being stopped has reported, go idle, or compact if the abort
came from `compact`. Every tool call ends with exactly one result, so the
conversation stays valid for providers.

## Compaction

It starts in four ways:

| Reason                    | When                                   | Then                                               |
| ------------------------- | -------------------------------------- | -------------------------------------------------- |
| manual                    | a `compact` input                      | inject queued messages and call the model, or idle |
| threshold, continuing     | before a model call in a run           | call the model                                     |
| threshold, not continuing | at the end of a turn                   | idle                                               |
| overflow                  | a reply failed with a context overflow | call the model                                     |

**The cut point.** Walk back from the newest entry, adding up estimated
tokens, until about `keepRecentTokens` are counted, then cut at the nearest
`user` or `assistant` entry at or after that point. A `tool_result` is never a
cut point: each tool result follows the assistant entry whose call it
answers, so cutting at an `assistant` entry keeps every call with its result.
Cutting at an `assistant` entry lets a long single turn be compacted too:
between turns the cut can fall inside the current turn, after its prompt, and
the summary then covers the start of the turn.

If there is nothing before the cut point to summarise, manual compaction
appends a `notice` and goes idle, and the other reasons carry on without
compacting.

**The summary.** `summarize` gets the range from the previous compaction's
first kept entry to the cut point, the previous summary if any, and a manual
compaction's instructions. When it arrives, append a `compaction` entry with
the summary and the cut point and update `snapshot.compaction`. Then call
the model if continuing; otherwise inject queued messages and call the model,
or go idle.

If `summarize` fails, append an error `notice` and go idle.

**What the model sees afterwards:** the summary, as a user message, then the
entries from the cut point on.

## Context size

Step estimates it when it needs it, from the entries since the latest
compaction's first kept one. The estimate starts from the latest reply's
reported token usage, skipping failed, aborted and zero usage, and adds about
one token per four characters of every entry after it; an image counts as 1200
tokens. If that usage is older than the latest compaction or `omit`, it no
longer describes the context, so the system prompt, the summary and every
entry are estimated instead.

## Rules that always hold

- Every tool call ends with exactly one `tool_result`.
- A prompt that starts a run is never summarised.
- The window starts at the latest compaction's first kept entry, or at the
  oldest queued message if that is older.
- Effect keys come from `nextKey` and are never reused.
- The snapshot never holds message content.

## Not in this version

- A limit on turns per run. pi has none; a model that keeps calling tools
  runs until aborted.
- pi's separate summary of the start of a turn that compaction cuts through.
