import { defineConfig } from '@acentric/cli/config';

export default defineConfig({
  agents: {
    notes: { agent: 'src/agent.ts', handlers: 'src/handlers.ts' },
  },
});
