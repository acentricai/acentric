// Adding a model call's usage to the session's totals.

import type { Usage } from '@acentric/llm';

import type { Totals } from './state.js';

export function addUsage(totals: Totals, usage: Usage | null | undefined): Totals {
  const cached = usage?.cacheRead ?? 0;
  const input = usage?.totalInput ?? (usage?.input ?? 0) + cached + (usage?.cacheWrite ?? 0);
  return {
    modelCalls: totals.modelCalls + 1,
    inputTokens: totals.inputTokens + input,
    cachedInputTokens: totals.cachedInputTokens + cached,
    outputTokens: totals.outputTokens + (usage?.output ?? 0),
    costUsd: totals.costUsd + (usage?.cost?.total ?? 0),
  };
}
