// The loop's snapshot part: where it is, the turn in progress, the counter
// for effect keys, and what the model calls have used. The loop puts the
// parts together, so its phase is every part's phases side by side.

import type { CompactionPhase } from '../compaction/index.js';
import type { ModelCallArgs } from '../model/index.js';
import type { RetryPhase } from '../retry/index.js';
import type { ToolsPhase } from '../tools/index.js';

/** The loop's own phases: no run going, or a model call running. */
export type LoopPhase =
  { type: 'idle' } | { type: 'calling_model'; key: string; args: ModelCallArgs };

/** Where the loop is. Each phase holds what `effects` needs to declare its effect. */
export type Phase = LoopPhase | ToolsPhase | RetryPhase | CompactionPhase;

/** The turn in progress: counters that start again with each turn. */
export type Turn = {
  startedAt: number;
  /** Model calls this turn, to stop a model that never stops calling tools. */
  modelCalls: number;
  /** An interrupt arrived: running effects are being aborted. */
  stopping: boolean;
};

export type LoopState = {
  phase: Phase;
  /** Null when idle. */
  turn: Turn | null;
  /** One counter for every effect key, such as llm:7, tool:8 and timer:9. */
  nextKey: number;
};

export const INITIAL_LOOP: LoopState = { phase: { type: 'idle' }, turn: null, nextKey: 1 };

/** Tokens and cost, added up over every model call. */
export type Totals = {
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type UsageState = { totals: Totals };

export const INITIAL_USAGE: UsageState = {
  totals: { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
};
