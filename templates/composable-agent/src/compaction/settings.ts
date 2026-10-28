// The compaction part's settings: its config with the defaults filled in,
// checked against the model that answers.

import { findModel } from '@acentric/llm';

import type { ModelRef } from '../core/model.js';
import type { CompactionConfig } from './config.js';

export type CompactionSettings = {
  summaryModel: ModelRef;
  compaction: { triggerTokens: number; keepTokens: number };
};

/**
 * Without a compaction threshold, compaction starts this many tokens before
 * the model's context window is full, leaving room for its reply.
 */
export const RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_TOKENS = 20_000;

/** `model` is the model that answers: its context window sets the default threshold. */
export function compactionSettings(
  config: CompactionConfig,
  model: ModelRef,
): CompactionSettings | { error: string } {
  const contextWindow = findModel(model.provider, model.id)?.contextWindow;
  const triggerTokens =
    config.compaction?.triggerTokens ??
    (contextWindow === undefined ? undefined : contextWindow - RESERVE_TOKENS);
  if (triggerTokens === undefined) {
    return {
      error: `${model.provider} model ${model.id} has no context window in @acentric/llm's catalog, so compaction.triggerTokens must be set`,
    };
  }
  const keepTokens = config.compaction?.keepTokens ?? DEFAULT_KEEP_TOKENS;
  if (keepTokens >= triggerTokens) {
    return {
      error: `compaction.keepTokens (${keepTokens}) must be below compaction.triggerTokens (${triggerTokens})`,
    };
  }
  return { summaryModel: config.summaryModel ?? model, compaction: { triggerTokens, keepTokens } };
}
