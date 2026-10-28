// The tools part's settings: its config with the defaults filled in.

import type { ToolsConfig } from './config.js';

/** What the agent's tools work from. Empty until a tool needs it. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type ToolsSettings = {};

/** Fills in the tools' defaults and checks them. Nothing to do until a tool has settings. */
export function toolsSettings(_config: ToolsConfig): ToolsSettings {
  return {};
}
