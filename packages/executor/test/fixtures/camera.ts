// An agent whose code gives images: one made of what it is sent, and one from a tool.

import { Agent } from '@acentric/agent';
import { z } from 'zod';

/** A picture, as an agent's code gives one: 2,000 bytes of `fill`, in base64. */
const picture = (fill: number) =>
  ({
    type: 'image',
    source: {
      type: 'base64',
      mediaType: 'image/png',
      data: btoa(String.fromCodePoint(...Array.from({ length: 2000 }, () => fill))),
    },
  }) as const;

export default new Agent({
  provider: 'fake',
  instructions: 'You say what is in pictures.',
  tools: [
    {
      name: 'take_picture',
      description: 'Takes a picture.',
      parameters: z.object({}),
      execute: () => [picture(7), { type: 'text', text: 'Taken.' }],
    },
  ],
  inputs: {
    message: {
      schema: z.object({ text: z.string(), picture: z.number().int().min(0).max(255).optional() }),
      handler: ({ text, picture: fill }) =>
        fill === undefined ? text : [{ type: 'text', text }, picture(fill)],
    },
  },
});
