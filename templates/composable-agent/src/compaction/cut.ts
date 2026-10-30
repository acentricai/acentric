// Where a compaction cuts: walking back from the newest entry until about
// `keepTokens` are counted, then at the nearest user or assistant entry at
// or after that point, so every tool call stays with its result. As in pi.

import type { LogEntry } from '@acentric/types';

import type { CompactionState } from './state.js';
import { entryTokens } from './tokens.js';

const CUTTABLE = new Set(['user', 'assistant']);

/** The first entry to keep after the summary, or null if nothing older than the newest `keepTokens` is left to summarise. */
export function cutPoint(
  entries: readonly LogEntry[],
  state: CompactionState,
  keepTokens: number,
): number | null {
  const from = state.compaction?.firstKeptSeq ?? 1;
  const kept = entries.filter((entry) => entry.seq >= from);
  let start = kept.length;
  let tokens = 0;
  for (const entry of kept.toReversed()) {
    if (tokens >= keepTokens) break;
    tokens += entryTokens(entry);
    start -= 1;
  }
  const cut = kept.slice(start).find((entry) => CUTTABLE.has(entry.kind));
  return cut !== undefined && cut.seq > from ? cut.seq : null;
}
