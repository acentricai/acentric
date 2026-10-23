# @acentric/client

Talk to an acentric runner from an application, in TypeScript.

**Embedding a runner:** start one as a child process and talk to it over
stdio. It lives as long as the connection: `close` ends its stdin and it
stops gracefully, letting running handlers finish.

```ts
import { spawnRunner } from '@acentric/client/node';

const { client } = await spawnRunner({ store: 'sqlite:./agents.db' });
await client.deploy({
  name: 'pi',
  version: '0.1.0',
  agentPath: 'agent.mjs',
  handlersPath: 'handlers.mjs',
});
await client.setSecret('OPENAI_API_KEY', key);

const { id } = await client.create('pi@0.1.0', { cwd, model });
await client.subscribe(id, { emits: true }, (event) => {
  if (event.type === 'emit') process.stdout.write(String(event.delta));
  if (event.type === 'log') render(event.entries);
});
await client.input(id, { kind: 'prompt', payload: { text: 'fix the tests' } });
```

**Connecting to a running one:** `connectWebSocket('ws://127.0.0.1:7420')`,
in Node or a browser.

**Providing kinds:** an application can run some effects itself, such as
asking its user. The bundle names those kinds when it is deployed
(`provides`), and the client that runs them passes handlers when it
connects:

```ts
const { client } = await spawnRunner({
  store: 'sqlite:./agents.db',
  provides: {
    ask_user: async (ctx) => {
      ctx.signal.addEventListener('abort', closeDialog);
      return { answer: await showDialog(ctx.args) };
    },
  },
});
```

A handler's result becomes the effect's `ok` outcome and a thrown error its
failure. While no client provides a kind, its effects wait.

Requests the runner refuses throw `RunnerRequestError`, whose `code` names
the problem, such as `no_session`.
