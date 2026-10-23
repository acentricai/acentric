import { defineConfig } from '@acentric/cli/config';

export default defineConfig({
  agents: {
    pi: { agent: 'src/entry/agent.ts', handlers: 'src/entry/handlers.ts' },
  },
  secrets: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
});
