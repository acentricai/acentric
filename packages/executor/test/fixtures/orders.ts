// An agent as a developer writes one, for the tests to build and run.

import { Agent, tool } from '@acentric/agent';
import { z } from 'zod';

/** Kept by the module between calls: each deployment of this code has its own. */
let lookups = 0;

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Finds an order by its number, and says what happened to it.',
  parameters: z.object({ id: z.number().int() }),
  retrySafe: true,
  execute: async ({ id }, { secrets }) => {
    lookups += 1;
    const key = await secrets.get('ORDERS_API_KEY');
    return `Order ${String(id)} was refunded twice, one second apart. (asked with ${key})`;
  },
});

export default new Agent({
  provider: 'fake',
  instructions: 'You answer questions about orders.',
  configuration: z.object({ region: z.string().default('eu') }),
  tools: [
    lookupOrder,
    {
      name: 'whoami',
      description: 'Says who the actor is, and how many orders this code has looked up.',
      parameters: z.object({}),
      execute: (_args, { agentName, actorName, externalId, configuration }) =>
        `${agentName}/${actorName ?? 'no name'}/${externalId ?? 'no external ID'} in ${configuration.region}, ${String(lookups)} lookups`,
    },
    {
      name: 'broken',
      description: 'Fails.',
      parameters: z.object({}),
      execute: () => {
        throw new RangeError('The order is out of range');
      },
    },
    {
      name: 'never',
      description: 'Never answers.',
      parameters: z.object({}),
      execute: () => new Promise<string>(() => {}),
    },
  ],
  inputs: {
    message: { schema: z.object({ text: z.string() }), handler: ({ text }) => text },
  },
  secrets: ['ORDERS_API_KEY'],
});
