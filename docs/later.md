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

- **Thrown values to Json.** How a runner turns what a handler threw into
  `Failure.error`, such as `Error` to `{ name, message }`.
- **Non-Json numbers.** Rejecting `NaN` and `Infinity` in outputs.
- **Runtime freezing.** Deep-freezing the state and message given to a step.
- **Send and wait.** A way for a caller to send an input and wait for the
  agent's answer to it.
- **`@send`.** Sending an input to another agent instance: reissue, deduplicated
  by key, with runner-defined addressing.
- **Purity checks.** Optionally checking that the pure half does no I/O.
- **`@timer`.** A timer kind, stored natively rather than held by a sleeping
  handler, taking an absolute time.
- **Suspend, unsuspend, terminate.** Operator controls. Undecided: whether
  suspend cancels running handlers or lets them finish, whether inputs that
  arrive while suspended are queued or refused. A suspend should not count
  toward a handler's attempts.
- **Upgrade policy.** Pinning instances to a version or upgrading them, and
  what happens to effects running during an upgrade.
- **Faulted instances.** What happens after a step fails deterministically,
  retrying infrastructure errors, and how an operator recovers.
- **Limits and defaults.** Effect counts, sizes, the log window, timeouts and
  attempts.
- **Log storage.** Paging, and whether old entries are ever deleted.
- **Effect status.** Showing an instance's effects as queued, running or
  finished, with attempts and timings.
- **Callers.** How long a caller waits for an input to be accepted or
  rejected, and stating the runner's durability.
- **Handler safety.** Child processes left behind by a crash, and guards such
  as allowlists, approval for `once` handlers, and sandboxes.
