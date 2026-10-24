# @acentric/replay

Runs an agent's pure half with no runner. It is what runners and the CLI use
to replay and fork sessions; for tests, use
[@acentric/testing](../testing), which re-exports it.

- **`simulate(agent, config)`** creates a session in memory and delivers
  messages to `step` one at a time, matching effects as a runner does. It runs
  no handlers: the caller reports their outcomes with `ok`, `fail` and
  `interrupt`, and plays the clock with `advance`. `upgrade(next)` moves the
  session to another version through its `migrate`.
- **`replay(journal, agents)`** delivers a session's journal again. Faithful
  replay, the default, runs each entry on the version that ran it and checks
  that it gives the answer and digest the journal recorded. What-if replay,
  `{ mode: 'what-if' }`, runs every entry on one agent from `init`, to see what
  that code would have done. Either way the result says which entries differ.
- **`journalDigest(snapshot, config, appended)`** computes a journal entry's
  digest: SHA-256 of the RFC 8785 canonical JSON of the three, as every runner
  computes it.

```ts
import { forReplay, replay } from '@acentric/replay';

const result = replay(journal, [forReplay(v1), forReplay(v2)]);
if (result.differs !== null) console.log(`entry ${result.differs} differs`);
```

`forReplay` erases an agent's types, so versions with different snapshots
replay together. The journal format and digest are in
[RUNNERS.md](../../RUNNERS.md#12-journal-and-forks); the design is in
[docs/replay.md](../../docs/replay.md).
