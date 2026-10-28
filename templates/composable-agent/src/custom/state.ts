// The custom part's snapshot part: the agent's own state, such as keeping a
// prompt cache warm.

import type { CustomSettings } from './settings.js';

// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type CustomState = {};

/** The custom part of a new session, from its settings. */
export function initialCustom(_settings: CustomSettings): CustomState {
  return {};
}
