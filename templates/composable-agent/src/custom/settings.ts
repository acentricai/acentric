// The custom part's settings: its config with the defaults filled in.

import type { CustomConfig } from './config.js';

// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type CustomSettings = {};

/** Fills in the defaults of the agent's own config and checks them. */
export function customSettings(_config: CustomConfig): CustomSettings {
  return {};
}
