import { defineConfig } from '@acentric/cli/config';

export default defineConfig({
  agents: {
    'composable-agent': { agent: 'src/agent.ts', handlers: 'src/handlers.ts' },
  },
});
