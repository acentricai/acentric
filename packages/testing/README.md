# @acentric/testing

Tests an agent with no runner: its pure half in memory, and its handlers on
their own.

```ts
import { handlerContext, simulate } from '@acentric/testing';
```

**The pure half.** `simulate(agent, config)` creates a session in memory and
delivers messages to `step` one at a time, matching effects as a runner does.
It runs no handlers: a test reports their outcomes with `ok`, `fail` and
`interrupt`, and plays the clock with `advance`.

```ts
const sim = simulate(agent, {});
const remind = sim.input('remind', { id: 1, inSeconds: 30 });
expect(remind.started).toEqual([{ key: 'remind:1:30000', kind: '@timer', args: { at: 30000 } }]);

sim.advance(30_000);
sim.ok('remind:1:30000', null);
expect(sim.log.at(-1)?.kind).toBe('reminder');
```

**Handlers.** `handlerContext({ args, log?, secrets? })` gives a handler the
context a runner would: its args, a signal to fire with the returned
`controller`, secrets that reject with `SecretNotSet` when missing, and a log
to read.

It also re-exports [@acentric/replay](../replay): `replay` to replay a
session's journal, and `Simulation.upgrade` to test a migration.
