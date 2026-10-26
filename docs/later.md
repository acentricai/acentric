# Later

Questions and features set aside while designing the framework, kept so the
reasoning is not lost. Items move out of this file when they are done or
dropped.

## Framework

- **Object storage for large data.** Images and other large values (file
  contents, big tool outputs) make log entries and effect results large. A
  store for blobs, referenced from the log by id, may belong in the framework
  or in runners. Not decided.
- **Window kind filter.** A step loads every entry in its window, whatever its
  kind, so bulky entries it never reads (images, file contents) are loaded on
  every step. `window` could also name the kinds a step needs, so the runner
  loads only those. Together with object storage, this is the answer to logs
  growing too large to load.
- **Log branching.** The log is linear. Harnesses with branching sessions (pi's
  `/tree`, `/fork`) can keep a tree in their own entry bodies for now.

## Runners

- **Thrown values to Json.** A thrown value's `toJSON()` is used when it gives
  Json (RUNNERS.md §8). Without one, how a runner turns what a handler threw
  into `Failure.error`, such as `Error` to `{ name, message }`, is still its
  own choice.
- **Non-Json numbers.** Rejecting `NaN` and `Infinity` in outputs.
- **Runtime freezing.** Deep-freezing the state and message given to a step.
- **Send and wait.** A way for a caller to send an input and wait for the
  agent's answer to it.
- **`@send`.** Sending an input to another agent session: reissue, deduplicated
  by key, with runner-defined addressing.
- **Purity checks.** Optionally checking that the pure half does no I/O.
- **`@timer`.** A timer kind, stored natively rather than held by a sleeping
  handler, taking an absolute time.
- **Faulted sessions.** Retrying infrastructure errors, and how an operator
  recovers a faulted session other than by upgrading it.
- **Operator controls in the protocol.** RUNNERS.md describes suspend, resume
  and close; the local runner's protocol and the conformance scenarios do not
  cover them yet.
- **Limits and defaults.** Effect counts, sizes, the log window, timeouts and
  attempts.
- **Log storage.** Paging, and whether old entries are ever deleted.
- **Effect status.** Showing a session's effects as queued, running or
  finished, with attempts and timings.
- **Callers.** How long a caller waits for an input to be accepted or
  rejected, and stating the runner's durability.
- **Handler safety.** Child processes left behind by a crash, and guards such
  as allowlists, approval for `once` handlers, and sandboxes.
