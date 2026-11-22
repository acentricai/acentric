// An agent whose tools try what code kept apart from the engine may and may not do. It is
// built by the tests and run in workerd.

import { Agent } from '@acentric/agent';
import { z } from 'zod';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default new Agent({
  provider: 'fake',
  instructions: 'You try things.',
  tools: [
    {
      name: 'echo',
      description: 'Gives back what it was given.',
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    },
    {
      name: 'platform',
      description: 'Says what the code finds around it.',
      parameters: z.object({}),
      execute: () =>
        JSON.stringify({
          fetch: typeof fetch,
          crypto: typeof crypto,
          setTimeout: typeof setTimeout,
          process: typeof (globalThis as { process?: unknown }).process,
          Buffer: typeof (globalThis as { Buffer?: unknown }).Buffer,
          require: typeof (globalThis as { require?: unknown }).require,
        }),
    },
    {
      name: 'secret',
      description: 'Reads a secret, after a while.',
      parameters: z.object({ name: z.string(), delayMs: z.number().default(0) }),
      execute: async ({ name, delayMs }, { secrets }) => {
        await sleep(delayMs);
        return secrets.get(name);
      },
    },
    {
      name: 'fetch',
      description: 'Fetches an address.',
      parameters: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        const response = await fetch(url);
        return `${String(response.status)} ${await response.text()}`;
      },
    },
    {
      name: 'sleep',
      description: 'Waits.',
      parameters: z.object({ ms: z.number() }),
      execute: async ({ ms }) => {
        await sleep(ms);
        return 'slept';
      },
    },
    {
      name: 'hang',
      description: 'Never settles, and waits on nothing.',
      parameters: z.object({}),
      execute: () => new Promise<string>(() => {}),
    },
    {
      name: 'spin',
      description: 'Never yields: everything in its process stops with it.',
      parameters: z.object({}),
      execute: () => {
        for (;;) {
          // Nothing.
        }
      },
    },
  ],
});
