// The compaction part's effect: summarising older history, and which part
// of the log a model call reads because of it.

import type { Usage } from '@acentric/llm';

import type { ModelRef } from '../core/model.js';

/**
 * The part of the log a model call reads: the summary in the compaction
 * entry at `summarySeq` if there is one, then the conversation entries with
 * fromSeq <= seq < toSeq.
 */
export type ContextRefs = { summarySeq: number | null; fromSeq: number; toSeq: number };

/** A summary of the entries with fromSeq <= seq < toSeq, extending the one at `previousSummarySeq`. */
export type SummarizeArgs = {
  model: ModelRef;
  fromSeq: number;
  toSeq: number;
  previousSummarySeq: number | null;
};

export type Summary = { summary: string; usage: Usage | null };

export type CompactionKinds = {
  /** Writes a summary of older history. Reissue. */
  summarize: { args: SummarizeArgs; result: Summary };
};
