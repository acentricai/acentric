# Replay and forks

Design decisions for recording what a session receives, replaying it, and
forking a session from an earlier point. This file records what was decided
and why; it follows the shape of [local-runner.md](local-runner.md).

## Why it is possible

Everything `step` sees is explicit: the state, one message and `now`. Effect
keys come from the agent, input ids from callers, and `step` does not know its
session's id. So a session is its first state plus the messages it received,
in order, each with its time and the code that handled it. Delivering them
again gives the same states and log. No handler runs during a replay: a
model's reply or a tool's result is already in the message that carried it.

The agent model does not change: no new message types, no new fields on what
`init`, `step` or `migrate` return.

## The journal

A runner MAY keep a journal per session. One that does records, in the same
save as the change it describes:

| Entry     | When                                | Holds                                       |
| --------- | ----------------------------------- | ------------------------------------------- |
| `init`    | A session is created                | version, `now`, config, digest              |
| `step`    | A message is delivered to `step`    | version, `now`, the message, answer, digest |
| `upgrade` | `migrate` moved the session's state | the new version, the old one, `now`, digest |

- Entries are numbered `n` = 1, 2, 3... per session, with no gaps.
- `step` entries include rejected inputs and config changes, and failed steps.
  They change nothing for the code that ran them, but other code replayed over
  the journal might accept them. `answer` is `accepted`, `rejected` or
  `failed`.
- A create that `init` rejects, an upgrade whose `migrate` rejects, and an
  input whose id was already answered change nothing and are not recorded.
- After an upgrade, the `migrated` message is its own `step` entry, on the new
  version, as it is its own step.
- A session faulted by a failed step and fixed by an upgrade has the failed
  `step` entry, the `upgrade` entry, the `migrated` entry, and the message
  again on the new version.

**Digest.** Each `init`, `upgrade` and accepted `step` entry holds a digest of
what it left: SHA-256, as lowercase hex, of the JSON Canonicalization Scheme
(RFC 8785) form of `[snapshot, config, appended]`, where `appended` is the
entries that change added, as `{ kind, body }`. A replay compares digests
entry by entry, so it can say where code first differs, even on a store that
keeps only the latest snapshot. Canonical JSON keeps the digest the same for
runners in any language.

Keeping the journal costs about one more record per step; agents that also log
their effect results store them twice. How long a runner keeps it is its
policy, like the log's.

## Replaying

`replay` in `@acentric/testing` replays a journal with no runner:

- **Faithful,** the default: each entry runs on the version that ran it, so it
  needs every version's code. It reproduces what happened, and checks that
  it does: each entry's answer and digest must match.
- **What if:** every entry runs on one given agent, from `init`, ignoring the
  recorded upgrades and their `migrated` messages. It answers what this code
  would have done with the same inputs and results, such as a fix tested on
  real sessions.

Either way the result lists each entry with what was expected and what
happened, and the first entry that differs.

`acentric replay <id>` runs faithful replay in the runner, through
`sessions/replay`, since the runner has every version's code. With
`--what-if`, the CLI builds the project's code for the session's agent and
replays the journal on it itself.

`Simulation` gains `upgrade(next)`, which runs `migrate` and delivers
`migrated`, as a runner does. The replayer uses it to cross upgrades, and
tests can use it to test a migration.

## Forks

A runner MAY fork a session at entry `n`: a new session with the state the
original had after that entry, which then goes its own way on the version
that ran entry `n`. Forks need faithful replay: a fork starts from what
actually happened.

- The fork's journal and log up to `n` are copies, with the same `n`s, seqs
  and times.
- An effect that had finished by `n` stays finished: its key never runs again
  in the fork.
- An effect running at `n` is handled as after a crash: a `reissue` effect
  starts again, at attempt 1 since the fork is a new session; a `once` effect
  is reported `interrupted`.
- Input ids answered up to `n` stay answered in the fork. A config change's
  request id is not, since the journal's config messages carry none.

Which effects had finished or were running at `n` follows from replaying the
journal, so a fork needs nothing recorded beyond it. The local runner builds a
fork's state with `replay` from `@acentric/testing`, which also checks every
digest, and saves the new session in one write. The memory runner replays
with its own step code.

A session created before its runner kept journals has none, and cannot be
replayed or forked: a journal that did not start with its creation could not
be replayed. The SQLite store moves a schema 2 store to schema 3 in place,
and its sessions keep no journal.

## Conformance

Two optional features, skipped and reported like `durable` and `upgrade`:

- `journal`: after every action of every scenario, the player replays the
  runner's journal faithfully with the probe's code. Every answer and digest
  must match, and the replayed log and snapshot must equal the runner's.
- `fork`: scenarios fork the session and check the effect rules above.

## Plan

| Milestone | Scope                                                                                      | Status |
| --------- | ------------------------------------------------------------------------------------------ | ------ |
| M1        | `JournalEntry` types; digest; `replay` and `Simulation.upgrade` in `@acentric/testing`     | Done   |
| M2        | The contract; journal and forks in the memory runner; the `journal` and `fork` conformance | Done   |
| M3        | Journal and forks in the local runner, both stores; `sessions/journal` and `sessions/fork` | Done   |
| M4        | `acentric replay` and `acentric fork`; the docs' replay page                               | Done   |
