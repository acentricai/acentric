// The tools part's snapshot part and phase.

import type { ToolsSettings } from './settings.js';

/** What the agent's tools keep between calls, such as a table of running commands. */
// oxlint-disable-next-line typescript/no-empty-object-type -- an agent adds its fields here
export type ToolsState = {};

/**
 * The tools part of a new session. It gets the settings, so a value that
 * must never change after creation, such as the id of the machine the tools
 * run on, can be copied from the config here.
 */
export function initialTools(_settings: ToolsSettings): ToolsState {
  return {};
}

/** One tool call of a reply. Its arguments are read from the reply in the log. */
export type ToolCall = {
  callId: string;
  /** The key of the effect running it. */
  key: string;
  done: boolean;
};

/** The calls of the reply at `replySeq`, in parallel or one at a time, as the tools say. */
export type ToolsPhase = { type: 'running_tools'; replySeq: number; calls: ToolCall[] };
