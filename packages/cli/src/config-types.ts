// What a project's acentric.config.ts says. Kept apart from the rest of the
// CLI, so a config file that imports `defineConfig` loads nothing else.

import type { Mode } from '@acentric/types';

export type AgentConfig = {
  /** The module whose default export is the agent's pure half. */
  agent: string;
  /** The module whose default export is the agent's handlers. */
  handlers: string;
  /** Defaults to the project's package.json version. */
  version?: string;
  /** Kinds the application that embeds the runner provides, with their settings. */
  provides?: Record<string, { mode: Mode; timeoutMs?: number; maxAttempts?: number }>;
  /**
   * What the handlers may use where they run. 'node', the default, allows
   * Node built-ins. 'fetch' builds them for runners whose handlers have only
   * the web platform, such as fetch and timers: no Node built-ins, and the
   * bundle imports nothing.
   */
  environment?: HandlerEnvironment;
};

/** What a runner's handlers may use, which decides how they are bundled. */
export type HandlerEnvironment = 'node' | 'fetch';

export type AcentricConfig = {
  /** The project's agents, by name. */
  agents: Record<string, AgentConfig>;
  /** The runner's store for `acentric start`: sqlite:PATH or fs:DIR. Defaults to sqlite:.acentric/store.db. */
  store?: string;
  /** Where `acentric start` listens. Defaults to ws://127.0.0.1:7420. */
  listen?: string;
  /** Environment variables to give handlers as secrets, such as OPENAI_API_KEY. A .env file is read first. */
  secrets?: string[];
  /** Where `acentric build` writes bundles. Defaults to .acentric/build. */
  outDir?: string;
};

/** Types a config file's default export. */
export function defineConfig(config: AcentricConfig): AcentricConfig {
  return config;
}
