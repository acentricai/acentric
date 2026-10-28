// The compaction part's log entries.

import type { ModelRef } from '../core/model.js';

export type CompactionEntries = {
  /** Older history replaced by a summary: the model sees it, then the entries from `firstKeptSeq`. */
  compaction: { summary: string; firstKeptSeq: number; tokensBefore: number; model: ModelRef };
};
