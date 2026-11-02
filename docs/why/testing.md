# Testing without mocks

_Feed step messages and check what it returns: no model, network or clock._

**The claim:** an agent's behaviour is tested by feeding `step` messages and
checking what it returns. There is no model, network or clock to fake, and a
test can start from any state.

## In a loop

Here is a loop that checks a website, retrying twice with a growing wait:

```ts
async function check(url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
```

To test that it gives up after the third failure, a test has to:

- replace `fetch` with a mock that fails three times, in order;
- replace the clock, so the test does not wait three seconds, and keep the fake
  timers and the pending promises moving in step;
- run attempts one and two to reach attempt three. The function has no way to
  start in the middle, because "attempt three" exists only while it runs.

Every test of a loop is a test of its mocks as well. For a model loop, the
mocks are a scripted model, scripted tools, and the order they answer in.

## As a reducer

The same behaviour as an agent. The waits are `@timer` effects, and how far it
has got is in its snapshot:

`src/agent.ts`:

```ts title="src/agent.ts"
import type { Agent, NoConfig } from '@acentric/types';

type Check = { id: string; url: string; attempt: number; retryAt: number | null };
type Snapshot = { check: Check | null };

export type CheckKinds = {
  fetch: { args: { url: string }; result: { status: number } };
  '@timer': { args: { at: number }; result: null };
};

const agent: Agent<Snapshot, NoConfig, CheckKinds> = {
  name: 'site-check',
  version: '0.1.0',
  kinds: ['fetch', '@timer'],

  init: () => ({ snapshot: { check: null } }),

  step: ({ snapshot }, message, now) => {
    const { check } = snapshot;
    if (message.type === 'input' && message.kind === 'check') {
      const url = message.payload['url'];
      if (typeof url !== 'string') return { error: 'check needs a url' };
      if (check !== null) return { error: 'already checking' };
      return {
        snapshot: { check: { id: message.id, url, attempt: 1, retryAt: null } },
      };
    }
    if (message.type !== 'effect' || check === null) return { snapshot };
    if (message.kind === '@timer') {
      return {
        snapshot: { check: { ...check, attempt: check.attempt + 1, retryAt: null } },
      };
    }
    if ('ok' in message.outcome) {
      const { status } = message.outcome.ok;
      return {
        snapshot: { check: null },
        append: [{ kind: 'up', body: { url: check.url, status } }],
      };
    }
    if (check.attempt < 3) {
      // Wait 1 second, then 2, before trying again.
      const retryAt = now + 1000 * 2 ** (check.attempt - 1);
      return { snapshot: { check: { ...check, retryAt } } };
    }
    return {
      snapshot: { check: null },
      append: [{ kind: 'down', body: { url: check.url } }],
    };
  },

  effects: ({ snapshot }) => {
    const { check } = snapshot;
    if (check === null) return [];
    const { id, url, attempt, retryAt } = check;
    if (retryAt !== null) {
      return [{ key: `${id}:wait:${attempt}`, kind: '@timer', args: { at: retryAt } }];
    }
    return [{ key: `${id}:fetch:${attempt}`, kind: 'fetch', args: { url } }];
  },
};

export default agent;
```

`simulate` from `@acentric/testing` runs an agent's pure half the way a runner
would, matching its effects, but runs no handlers. The test plays each
handler's result by hand, and plays the clock with `advance`. Starting in the
middle is calling `step` with that state:

`test/agent.test.ts`:

```ts title="test/agent.test.ts" run
import assert from 'node:assert/strict';

import { simulate } from '@acentric/testing';

import agent from '../src/agent.js';

// Two failures, then success: no network, and no real waiting.
const site = simulate(agent, {});
site.input('check', { url: 'https://example.com' }, 'c1');
site.fail('c1:fetch:1', 'threw', 'connection reset');
assert.deepEqual(site.running, [
  { key: 'c1:wait:1', kind: '@timer', args: { at: 1000 } },
]);

site.advance(1000);
site.ok('c1:wait:1', null);
site.fail('c1:fetch:2', 'timeout');
assert.deepEqual(site.effect('c1:wait:2').args, { at: 3000 });

site.advance(2000);
site.ok('c1:wait:2', null);
site.ok('c1:fetch:3', { status: 200 });
assert.deepEqual(site.log.at(-1)?.body, { url: 'https://example.com', status: 200 });
assert.deepEqual(site.running, []);

// Or start at the third attempt, and check that its failure gives up.
const result = agent.step(
  {
    snapshot: {
      check: { id: 'c1', url: 'https://example.com', attempt: 3, retryAt: null },
    },
    log: { start: 1, next: 1, entries: [] },
    config: {},
  },
  {
    type: 'effect',
    key: 'c1:fetch:3',
    kind: 'fetch',
    outcome: { failed: { code: 'threw', error: null } },
  },
  5000,
);
assert.deepEqual(result, {
  snapshot: { check: null },
  append: [{ kind: 'down', body: { url: 'https://example.com' } }],
});
```

The handlers are tested on their own. `handlerContext` from
`@acentric/testing` gives a handler its args, a signal, secrets and a log to
read, with no runner. A `fetch` handler's test checks how it calls the site;
the agent's test never needs to know.

## The proof

- **The test above runs in our docs check.** If the agent stops behaving as the
  page says, the docs check fails.
