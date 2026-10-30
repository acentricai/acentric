// The compaction part's side of the loop: whether to compact, where, what
// the summary call is given, what a summary changes, and what a model call
// reads. The loop calls these at the points STEP.md names and applies what
// they return. Another strategy, or none, exports the same functions.

import type { LogEntry } from '@acentric/types';

import type { CompactionEntries } from './log.js';
import type { ContextRefs, SummarizeArgs, Summary } from './kinds.js';
import type { CompactionSettings } from './settings.js';
import type { CompactionPhase, CompactionState } from './state.js';
import { cutPoint } from './cut.js';
import { estimateContext } from './tokens.js';

/** Whether to compact now, before the model's next call or once a turn ends: the context is over the threshold. */
export function shouldCompact(
  state: CompactionState,
  entries: readonly LogEntry[],
  settings: CompactionSettings,
): boolean {
  return estimateContext(entries, state) > settings.compaction.triggerTokens;
}

/** Whether to compact after the model said the context is too large: once a turn. */
export function compactOnOverflow(state: CompactionState): boolean {
  return !state.overflowCompacted;
}

/** Where to cut, and the context's size before it, or null if nothing is left to summarise. */
export function planCompaction(
  state: CompactionState,
  entries: readonly LogEntry[],
  settings: CompactionSettings,
): { firstKeptSeq: number; tokensBefore: number } | null {
  const firstKeptSeq = cutPoint(entries, state, settings.compaction.keepTokens);
  return firstKeptSeq === null
    ? null
    : { firstKeptSeq, tokensBefore: estimateContext(entries, state) };
}

/** What the summary call is given: the entries from the last cut to this one, and the summary it extends. */
export function summarizeArgs(
  state: CompactionState,
  phase: CompactionPhase,
  settings: CompactionSettings,
): SummarizeArgs {
  return {
    model: settings.summaryModel,
    fromSeq: state.compaction?.firstKeptSeq ?? 1,
    toSeq: phase.firstKeptSeq,
    previousSummarySeq: state.compaction?.entrySeq ?? null,
  };
}

/** The entry recording a summary. */
export function compactionEntry(
  phase: CompactionPhase,
  summary: Summary,
  settings: CompactionSettings,
): CompactionEntries['compaction'] {
  return {
    summary: summary.summary,
    firstKeptSeq: phase.firstKeptSeq,
    tokensBefore: phase.tokensBefore,
    model: settings.summaryModel,
  };
}

/** The compaction part once the summary at `entrySeq` is appended. */
export function compacted(
  phase: CompactionPhase,
  entrySeq: number,
): Pick<CompactionState, 'compaction'> {
  return { compaction: { entrySeq, firstKeptSeq: phase.firstKeptSeq } };
}

/** The compaction part when a turn starts. */
export function atTurnStart(): Pick<CompactionState, 'overflowCompacted'> {
  return { overflowCompacted: false };
}

/** The compaction part once it starts compacting after an overflow. */
export function overflowCompacting(): Pick<CompactionState, 'overflowCompacted'> {
  return { overflowCompacted: true };
}

/** What a model call reads: the latest summary, then the entries from its first kept one up to `toSeq`. */
export function contextRefs(state: CompactionState, toSeq: number): ContextRefs {
  return {
    summarySeq: state.compaction?.entrySeq ?? null,
    fromSeq: state.compaction?.firstKeptSeq ?? 1,
    toSeq,
  };
}
