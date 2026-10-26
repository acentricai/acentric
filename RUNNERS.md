# Runners

A runner is a program that takes an agent and runs sessions of it. Runners
can be very different: in memory for tests, on a laptop with a local
database, on a fleet of servers, in Cloudflare Durable Objects. This
document is the contract they share, so that an agent written against the
framework behaves the same on every runner that conforms to it, apart from
the differences listed under [What a runner chooses](#what-a-runner-chooses).

The types it refers to are in [packages/types](packages/types).

- **MUST**: every runner does this.
- **SHOULD**: every runner does this unless it has a reason not to.
- **MAY**: a runner can choose.
- **MUST NOT**: no runner does this.

## 1. What a runner is

A runner MAY be written in any language, but it MUST be able to run
JavaScript, because an agent is JavaScript: its `init`, `step` and handlers
are functions. The runner and the agent exchange only plain JSON: state,
messages, effect requests and results. A runner treats an agent's snapshot,
config, args and results as opaque JSON; their types matter only to the
agent's author.

A runner's work, per session, is one loop:

1. Take the next message.
2. Give it to `step` with the session's state.
3. Save what `step` returned, all at once.
4. Match the effects that should exist to the effects that are running.
5. Run handlers, and turn what they produce into new messages.

## 2. Loading an agent

An agent comes as a bundle of ES modules:

| Module        | Default export                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `agent.js`    | The `Agent` without `handlers`: `name`, `version`, `init`, `step`, and optionally `effects`, `window`, `view`, `migrate`   |
| `handlers.js` | The `Handlers`: for each kind, `{ mode, run, timeoutMs?, maxAttempts? }`. Left out by an agent with no handlers of its own |

Splitting the two lets a runner run them in different places, such as the
pure half in a restricted sandbox and the handlers where they can do I/O.

- A runner MUST accept the two-module form.
- A runner MAY also accept a single `agent.js` whose `Agent` includes
  `handlers`.
- A runner that is a library MAY also take an `Agent` object directly.
- A runner MUST refuse to load an agent with a handler whose name starts
  with `@`; those names belong to runners.
- A runner MAY refuse an agent whose handlers need an environment it does
  not offer, such as a shell.
- `(name, version)` identifies an agent's code. A runner MUST NOT load two
  different bundles under the same name and version.

## 3. Sessions

- Creating a session MUST run `init(config, now)`. If init rejects or
  fails, the session is not created and the creator receives the error.
- For each session, a runner keeps its snapshot, its log, its config, its
  effects (declared, running, finished) and the messages waiting for it.
- How sessions are named and addressed is the runner's choice.

## 4. Messages

A runner MUST deliver exactly four types of message, all readonly:

| Type       | Comes from                                |
| ---------- | ----------------------------------------- |
| `input`    | a caller                                  |
| `effect`   | a finished effect, reported by the runner |
| `config`   | a caller changing the session's config    |
| `migrated` | the runner, after upgrading the session   |

**One at a time.** A runner MUST NOT run two steps of one session at
once, or start a step before the previous one is saved.

**Order.**

- Inputs and config changes MUST be delivered in the order the runner
  accepted them from callers.
- Effect results are delivered in the order the effects finished, and MAY
  come between inputs. Nothing orders an input against an effect result
  that finishes at about the same time.
- After an upgrade, `migrated` MUST be the first message the new version
  receives.

**Answering callers.** An input or config change is accepted or rejected by
`step`. A runner MUST NOT tell a caller its input was accepted until the
step that handled it has been saved: rejected if `step` rejected it,
accepted otherwise. A runner MAY say earlier that it has received and
queued the input.

**Redelivery.** If a step fails, the runner MUST deliver the same message
again if it delivers it at all, unchanged.

## 5. Steps

To run a step, the runner builds the state, `{ snapshot, log, config }`
with the log window (section 6), and calls `step(state, message, now)`.

**Time.** `now` is milliseconds since the Unix epoch. For a session it
MUST never go backwards: never earlier than the `at` of its latest log
entry. A runner spread across machines keeps it so whatever their clocks
say.

**Checking the result.** The result, and everything `effects`, `window` and
`view` return for the new state, MUST be plain JSON (no `undefined`, `NaN`,
`Infinity`, functions or class instances), within the runner's limits, with
no effect key twice in one list.

**Saving.** A runner MUST save all of a step at once or none of it: the
new snapshot, the appended log entries, the change to the effects, and the
message being marked as delivered. Log entries get the next `seq` in order,
with no gaps, and `at` set to the step's `now`.

**Rejections.** If `step` returns `{ error }`:

- for an `input` or `config`, nothing is saved, the message is used up, and
  the caller receives the error;
- for an `effect` or `migrated` message, which no caller sent, it is a
  failure, as below.

**Config.** A `config` message's new config takes effect only if the step
accepts it. While that step runs, the state holds the current config; the
message holds the new one. Once the step is accepted, the new config is in the
state that `effects`, `window` and `view` see for its result, and in every
later step's.

**Failures.** A step fails if it throws, returns something that is not
JSON, goes over a limit, or if `effects`, `window` or `view` does so on the
state it returns. A failed step MUST apply nothing. Being pure, it would
fail the same way again on the same message, so what happens next is the
runner's policy, such as stopping the session until someone acts. A runner
that drops the message instead MUST make that visible.

A runner MUST NOT change a state or message it gave to `step`, and an
agent's state changes only through `step`, `init` and `migrate`.

## 6. The log and the window

After `init`, every accepted step and every `migrate`, a runner MUST call
`window(snapshot)` if the agent has it, to know which entries the next step
needs. A value below 1 means 1, and one above the next `seq` means none.
Without `window`, a step sees the whole log. The window MAY move backwards.

The step sees `log` as `{ start, next, entries }`: the first `seq` in
`entries`, the `seq` the next entry will get, and every entry from `start`
to `next - 1`. `next` is correct even when `entries` is empty.

A runner MAY refuse a window larger than its limit, as a failure.

Handlers read any part of the log with `ctx.log.list`, filtering by `after`,
`before` and `kinds` and paging with `limit` and `cursor`. Whether a runner
ever deletes old entries is its choice, and it MUST say so; reading deleted
entries finds nothing.

## 7. Effects

After `init`, every accepted step, every `migrate` and every restart, a
runner MUST call `effects(state)` if the agent has it, and match the list
it returns to the effects it is running:

| In the list                                  | Running                  | The runner                                                                |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| a key it has not run                         | no                       | starts it                                                                 |
| a key                                        | yes                      | leaves it running; any change to its args is ignored                      |
| a key newly marked `abort: true`             | yes                      | fires its signal, and delivers whatever it returns as an `effect` message |
| no longer                                    | yes, or waiting to start | cancels it: fires its signal, discards its result, delivers nothing       |
| a key that already finished or was cancelled | no                       | ignores it: keys are single-use                                           |

**Saved before started.** A durable runner MUST save an effect's declaration
before its handler starts, so that after a crash it can tell an effect that
may have started from one that never existed.

**Kinds.** A kind is either one of the agent's handlers or one of the
runner's built-in kinds. A kind that is neither is reported at once as
failed with `unknown_kind`.

**Mode.** An effect's mode is the request's `mode` if given, otherwise its
handler's.

## 8. Handlers

A runner runs a handler with a context:

| Field     | What the runner gives                                                        |
| --------- | ---------------------------------------------------------------------------- |
| `key`     | the effect's key                                                             |
| `kind`    | the kind requested                                                           |
| `args`    | the request's args                                                           |
| `attempt` | 1 on the first run, then one more on every run of the same key after a crash |
| `signal`  | an `AbortSignal` that fires on cancel, abort and timeout                     |
| `secrets` | `get(name)`, from wherever the runner keeps them                             |
| `log`     | `list(query)`, reading the session's log                                     |

**Secrets.** `secrets.get(name)` resolves with the secret's value, a string.
When no secret has that name, it MUST reject with an `Error` whose `name` is
`SecretNotSet`, so a handler can tell a secret that is not set from one that
could not be read, and choose another. Any other failure to read a secret
MUST NOT use that name.

**Outcomes.** What the handler does becomes the `outcome` of an `effect`
message:

| The handler                                          | Outcome                                       |
| ---------------------------------------------------- | --------------------------------------------- |
| returns a JSON value                                 | `{ ok: value }`                               |
| returns something that is not JSON                   | failed, `invalid_result`                      |
| returns a result over the runner's size limit        | failed, `limit_exceeded`                      |
| throws                                               | failed, `threw`, with what was thrown as JSON |
| throws after the agent marked it `abort`             | failed, `aborted`                             |
| runs past its time limit                             | failed, `timeout`                             |
| `once`, and was cut off by a crash                   | `{ interrupted: true }`                       |
| `reissue`, and was cut off by crashes too many times | failed, `attempts_exhausted`                  |

A failure's `error` is JSON. How a runner turns a thrown value into JSON is
its choice; an `Error` is typically `{ name, message }`.

**Modes.**

- `reissue`: if the runner loses a run, by crashing or otherwise, it MUST
  run it again with `attempt` one higher, up to the handler's `maxAttempts`
  or the runner's default, and then report `attempts_exhausted`.
- `once`: a runner MUST NOT run it again. If a run is lost, it reports
  `{ interrupted: true }`: it may or may not have done its work.

A handler that throws or times out is not run again by the runner; whether
to try again is the agent's decision.

**Time limits.** A handler's `timeoutMs`, or the runner's default, counts
from when its run starts, not from when it was requested. On a timeout the
runner fires the signal and reports `timeout`.

**Limits.** The numbers are the runner's; what the agent experiences is
fixed:

- More effects declared at once than allowed, or args or a result larger
  than allowed: those effects fail on their own with `limit_exceeded`, and
  the step is saved as usual. When too many are declared, the ones at the
  end of the list are refused.
- More effects than may run at once, overall or per kind: the rest wait
  their turn. The agent sees nothing.

## 9. Built-in kinds

A runner MAY provide kinds of its own, such as a timer. Their names start
with `@`. They are requested and answered like any other kind, with the
same outcomes. A runner documents each one's args, result and mode, and
SHOULD export their types as a map of kinds, so a typed agent can add them
to its own. Runners that offer the same thing SHOULD use the same name and
shape, so agents can move between them.

## 10. Durability and recovery

A runner MUST say what it keeps and what survives: nothing past the
process, a process crash, the loss of a machine.

Within what it keeps, a crash MUST look the same as on every other runner:

- steps already saved are never lost and never applied twice;
- a message whose step was not saved is delivered again;
- effects are matched again with `effects(state)`;
- a `reissue` effect that was running runs again, with `attempt` one higher;
- a `once` effect that was running is reported `interrupted`.

**Restarts that are not crashes.** A runner can stop a run on purpose: by
suspending a session, by upgrading it, or by rebuilding a sandbox that other
runs shared. For the runs it stops, each MUST look to the agent like a crash:
a `reissue` effect runs again with `attempt` one higher, and a `once` effect
is reported `interrupted`. A restart the runner chose MUST NOT count toward a
handler's `maxAttempts`, so it is never the reason an effect fails with
`attempts_exhausted`.

**Operator controls.** A runner MAY offer controls the agent does not see:

- **Suspend** stops a session. If it stops running handlers, their signals
  fire and their results are discarded. Timers do not fire while a session is
  suspended. Inputs and config changes that arrive meanwhile are queued, not
  refused.
- **Resume** restarts a suspended session as after a crash: effects are
  matched again with `effects(state)`, stopped runs restart as above, and
  overdue timers fire.
- **Close** ends a session for good: every effect is cancelled and no message
  is delivered.

None of these is a message. An agent that wants to stop its own work, such as
when a user presses stop, defines an input for it and drops or aborts the
effects in question.

## 11. Upgrades

A runner MAY upgrade sessions to a new version of their agent. If it does:

- it upgrades between steps, never during one;
- it calls the new version's `migrate(snapshot, config, from)` if it has
  one, and otherwise keeps the snapshot and config;
- if `migrate` rejects or fails, the session stays on its old version;
- otherwise it saves the new snapshot and config, and delivers `migrated`
  as the new version's first message.

Whether sessions are pinned to their version or upgraded, and what happens
to effects running during an upgrade, are the runner's choice:

- A runner that keeps them running delivers their results to the new
  version's `step`.
- A runner that cannot keep the old version's handlers running stops them
  as described in [Restarts that are not crashes](#10-durability-and-recovery):
  after `migrate`, effects are matched on the migrated state, and every key it
  still declares runs again on the new version's handler, or is reported
  `interrupted` if it is `once`.

An upgrade MAY clear a session that a failed step left faulted. The message
whose step failed is then delivered again, to the new version, after
`migrated`.

## 12. Journal and forks

A runner MAY keep a journal of what each session received (the
`JournalEntry` type), so a session can be replayed. If it does, it records
an entry in the same save as the change the entry describes:

- `init` when a session is created: the version, `now`, config and digest;
- `step` for every message delivered to `step`, with the version that
  received it, `now`, the message, the answer (`accepted`, `rejected` or
  `failed`) and, for an accepted step, the digest. Rejected inputs and
  config changes and failed steps are recorded too;
- `upgrade` when `migrate` moves a session: the new version, the old one,
  `now` and the digest. `migrated` is then its own `step` entry, on the new
  version.

Entries are numbered `n` = 1, 2, 3... per session, with no gaps. A create
that `init` rejects, an upgrade that `migrate` rejects, and an input whose id
was already answered change nothing and are not recorded.

A digest is SHA-256, as lowercase hex, of the RFC 8785 canonical JSON of
`[snapshot, config, appended]`, where `appended` holds the entries the change
added, as `{ kind, body }`.

A runner that keeps a journal MAY fork a session at entry `n`: a new session
with the state the original had after that entry, on the version that ran it.
It MUST rebuild that state by replaying the journal up to `n`, refusing if a
digest differs, and then:

- copy the journal and the log up to `n`, with the same numbers and times;
- keep every effect that had finished by `n` finished;
- start effects that were running at `n` again, as after a crash, but at
  attempt 1, and report `once` effects `interrupted`;
- keep the input ids answered up to `n` answered, if it remembers input ids.

## What a runner chooses

| Area                     | For example                                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| Storage and durability   | memory, files, SQLite, Postgres, Durable Object storage                       |
| Topology                 | one process, many processes, many machines, one Durable Object per session    |
| Where the pure half runs | the same process, an isolate, a sandbox with purity checks                    |
| Where handlers run       | the same process, worker threads, child processes, containers, remote workers |
| Handler environment      | full Node, fetch only, browser APIs                                           |
| Built-in kinds           | `@timer`, `@send`, or none                                                    |
| Clock                    | local, database, a single clock across machines                               |
| Caller interface         | function calls, HTTP, SSE, WebSocket, a CLI                                   |
| Identity                 | counters, UUIDs, names                                                        |
| Limits and defaults      | effect counts, sizes, the window, time limits, attempts                       |
| Policies                 | failed steps, upgrades, log and journal retention                             |
| `view`                   | when views are computed and served                                            |
| Secrets                  | environment variables, a vault, per-tenant stores                             |
| Security                 | authentication, which callers may send which inputs, sandboxes, approvals     |
| Operator controls        | suspend, resume, terminate                                                    |
| Observability            | effect status, logs, metrics                                                  |

## What a runner must not do

- Add message types, or fields to what `init`, `step` or `migrate` return.
  Features an agent asks for go through the framework, or through built-in
  `@` kinds.
- Weaken anything this document says a runner MUST do.
- Change an agent's state other than through `init`, `step` and `migrate`.
- Invent identities: input ids come from callers, effect keys from the
  agent.

## Conformance

A runner conforms when it passes the scenarios in
[packages/conformance](packages/conformance): JSON files that drive a small
test agent, the probe, through messages and handler outcomes and say what
must happen, played through an adapter each runner provides. Scenarios that
need a feature a runner does not offer, such as durability or upgrades, are
skipped and reported.
