// The acentric CLI's commands, for use from code: load a project, build its
// agents, start a runner with them.

export { BuildError, buildAgent, buildProject } from './build.js';
export { devProject } from './dev.js';
export type { DevEvent, DevOptions, DevServer } from './dev.js';
export type { BuildOptions, BuiltAgent, KindSettings, Manifest } from './build.js';
export { ConfigError, loadProject } from './config.js';
export type { Project } from './config.js';
export { defineConfig } from './config-types.js';
export type { AcentricConfig, AgentConfig } from './config-types.js';
export { formatEntry } from './inspect.js';
export { StartError, startProject } from './start.js';
export type { Started, StartOptions } from './start.js';
