// The compaction part's snapshot part and phase, and the log it needs a
// step to see.

/** The latest compaction, and whether an overflow was already compacted this turn. */
export type CompactionState = {
  /** The latest compaction's entry, and the first entry kept after it. */
  compaction: { entrySeq: number; firstKeptSeq: number } | null;
  /** Compacting after a context overflow is tried once per turn. */
  overflowCompacted: boolean;
};

export const INITIAL_COMPACTION: CompactionState = { compaction: null, overflowCompacted: false };

/** Summarising the entries before `firstKeptSeq`, then calling the model if `thenContinue`. */
export type CompactionPhase = {
  type: 'compacting';
  key: string;
  reason: 'threshold' | 'overflow';
  firstKeptSeq: number;
  /** The estimated context when it started, for the record. */
  tokensBefore: number;
  thenContinue: boolean;
};

/** The first seq a step needs: the latest compaction's first kept entry, or the whole log. */
export function compactionWindow(state: CompactionState): number {
  return state.compaction?.firstKeptSeq ?? 1;
}
