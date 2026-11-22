// The smallest agent whose actors work on a machine.

import { Agent } from '@acentric/agent';

export default new Agent({
  provider: 'fake',
  instructions: 'You do work on your machine.',
  machine: true,
});
