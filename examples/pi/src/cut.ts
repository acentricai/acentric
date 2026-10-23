// Where compaction cuts: the first entry it keeps.
//
// Walk back from the newest entry, adding up estimated tokens, until about
// `keepRecentTokens` are counted, then cut at the nearest `user` or
// `assistant` entry at or after that point. A `tool_result` is never a cut
// point: each one follows the reply whose call it answers, so cutting at an
// `assistant` entry keeps every call together with its result. Cutting at
// an `assistant` entry also lets one long turn be compacted.

import type { LogEntry } from '@acentric/types';

import { isKind } from './entries.js';
import { entryTokens } from './tokens.js';

/**
 * The seq of the first entry to keep, or null if nothing would be left to
 * summarise. `entries` should start at the latest compaction's first kept
 * entry.
 */
export function findCutPoint(
  entries: readonly LogEntry[],
  keepRecentTokens: number,
): number | null {
  const omitted = new Set<number>();
  for (const entry of entries) if (isKind(entry, 'omit')) omitted.add(entry.body.seq);
  const visible = entries.filter(
    (entry) =>
      !omitted.has(entry.seq) &&
      (isKind(entry, 'user') || isKind(entry, 'assistant') || isKind(entry, 'tool_result')),
  );
  const cutPoints = visible
    .filter((entry) => !isKind(entry, 'tool_result'))
    .map((entry) => entry.seq);
  const first = visible[0];
  if (first === undefined || cutPoints.length === 0) return null;

  let counted = 0;
  for (let index = visible.length - 1; index >= 0; index--) {
    const entry = visible[index];
    if (entry === undefined) continue;
    counted += entryTokens(entry);
    if (counted >= keepRecentTokens) {
      const cut = cutPoints.find((seq) => seq >= entry.seq) ?? cutPoints[cutPoints.length - 1];
      return cut === undefined || cut <= first.seq ? null : cut;
    }
  }
  // Everything fits in what compaction keeps.
  return null;
}
