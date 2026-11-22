// The smallest agent that does something, with a schema written by hand: so that what the
// framework itself adds to a bundle can be weighed.

import { Agent } from '@acentric/agent';
import type { ToolSchema } from '@acentric/agent';

const nothing: ToolSchema<{}> = {
  '~standard': {
    version: 1,
    vendor: 'by-hand',
    validate: () => ({ value: {} }),
    jsonSchema: {
      input: () => ({ type: 'object', properties: {} }),
      output: () => ({ type: 'object', properties: {} }),
    },
  },
};

export default new Agent({
  provider: 'fake',
  instructions: 'You say hello.',
  tools: [
    { name: 'hello', description: 'Says hello.', parameters: nothing, execute: () => 'hello' },
  ],
});
