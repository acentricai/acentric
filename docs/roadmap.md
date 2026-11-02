# Roadmap

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
- **Log branching.** The log is linear. Harnesses with branching sessions (such as a
  `/tree` or `/fork` command) can keep a tree in their own entry bodies for now.

## Runners

- **Thrown values to Json.** A thrown value's `toJSON()` is used when it gives
  Json (the [runner spec](reference/runner-spec.md) §8). Without one, how a runner turns what a handler threw
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
- **Shutdowns that count as attempts.** the [runner spec](reference/runner-spec.md) §10 says a restart the
  runner chose never counts toward `maxAttempts`. The local runner's graceful
  `close()` stops handlers still running after the grace period, and the next
  `start()` reruns them with the next attempt, counted toward the limit, so a
  long effect can fail `attempts_exhausted` after a few restarts. The store
  needs to record which stops were the runner's choice (a SQLite schema
  change and a files-format change), and the limit check leave them out
  while `attempt` still goes up.
- **Operator controls in the protocol.** The [runner spec](reference/runner-spec.md) describes suspend, resume
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

## @acentric/llm

- **Hosted tools in usage and cost.** The client reads token counts only. It
  does not read hosted tool use: Anthropic's `usage.server_tool_use` (web
  search and fetch requests) and code execution time, or the `*_call` output
  items of OpenAI and Fireworks (web and file search, code interpreter, image
  generation). So `usage.cost` for a call that uses them covers its tokens and
  quietly leaves out the tools' own charges. `Usage` should count tool uses,
  the catalog should price those with published prices, and `cost` should be
  left out when a tool's price is not known, as it already is for tokens.
  acentric-cloud's gateway charges calls at cost from this figure.
- **OpenAI's 12-hour cache writes.** OpenAI added a 12-hour lifetime for
  prompt caches (`prompt_cache_options.ttl`, GPT-5.6 and later), reported as
  writing at 2.5 times the input price against 1.25 times for the 30-minute
  default; reads are unchanged. Confirm against OpenAI's pricing page. The
  client prices every OpenAI cache write at the catalog's one `cacheWrite`
  price, so 12-hour writes are priced too low, and the `ttl` type names only
  `'30m'`. The fix is the one Anthropic's hour-long writes have
  (`cacheWrite1h`): a price for each lifetime and writes split by lifetime.
  The request's `ttl` alone does not settle the split, since a breakpoint can
  override it and a token is billed at the longest lifetime covering it; use
  a breakdown in `usage` if OpenAI reports one, and otherwise leave `cost` out
  when lifetimes are mixed.
