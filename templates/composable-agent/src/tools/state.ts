// The tools part's snapshot part and phase.

import type { Json } from '@acentric/types';

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

/**
 * One call of a reply that runs as an effect. Its arguments are read from
 * the reply in the log; what `prepare` passed on is kept here, since
 * `effects` must declare the same args every time it is asked.
 */
export type CallState = {
  callId: string;
  /** The tool's name: its effect kind is `tool:<name>`. */
  name: string;
  /** The key of the effect running it. */
  key: string;
  /** What `prepare` passed on to the handler. */
  extra: Json;
  /** Waiting for calls before it to finish, running, or answered. */
  status: 'waiting' | 'running' | 'done';
};

/**
 * The calls of the reply at `replySeq` that run as effects, in the order
 * the model made them, in parallel or one at a time as their tools say.
 * Calls answered at once are already in the log.
 */
export type ToolsPhase = { type: 'running_tools'; replySeq: number; calls: CallState[] };
