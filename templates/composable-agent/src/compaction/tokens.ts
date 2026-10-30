// Roughly how many tokens the model reads: the newest reply's reported
// usage, plus about one token per four characters of every entry after it.
// Usage from before the latest compaction no longer describes the context,
// so until a reply comes after it, the summary and every kept entry are
// estimated instead. As in pi and meals.

import type { ContentPart, Usage } from '@acentric/llm';
import type { LogEntry } from '@acentric/types';

import { logOf } from '../core/log.js';
import type { ConversationEntries } from '../core/log.js';
import type { CompactionEntries } from './log.js';
import type { CompactionState } from './state.js';

const seen = logOf<ConversationEntries & CompactionEntries>();

/** What an image or a file counts for, whatever its size. */
export const ATTACHMENT_TOKENS = 1_200;

/** Roughly how many tokens the model's next call reads from `entries`, the window and what this step appended. */
export function estimateContext(entries: readonly LogEntry[], state: CompactionState): number {
  const from = state.compaction?.firstKeptSeq ?? 1;
  const compactedAt = state.compaction?.entrySeq ?? 0;
  let tokens = 0;
  let since = from;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.seq <= compactedAt) break;
    if (seen.isKind(entry, 'assistant')) {
      const used = contextUsed(entry.body.usage);
      if (used !== null) {
        tokens = used;
        since = entry.seq + 1;
        break;
      }
    }
  }
  for (const entry of entries) {
    if (entry.seq >= since) tokens += entryTokens(entry);
  }
  return tokens;
}

/** Roughly how many tokens one entry adds to what the model reads. Entries it never sees add none. */
export function entryTokens(entry: LogEntry): number {
  if (seen.isKind(entry, 'user') || seen.isKind(entry, 'tool_result')) {
    return entry.body.content.reduce((sum, part) => sum + partTokens(part), 0);
  }
  if (seen.isKind(entry, 'assistant'))
    return textTokens(JSON.stringify(entry.body.message.content));
  if (seen.isKind(entry, 'compaction')) return textTokens(entry.body.summary);
  return 0;
}

/** What a reply's call read and wrote, if its provider reported it. */
function contextUsed(usage: Usage | undefined): number | null {
  if (usage === undefined) return null;
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite].filter((n) => n !== undefined);
  const input = usage.totalInput ?? (parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null);
  return input === null ? null : input + (usage.output ?? 0);
}

function partTokens(part: ContentPart): number {
  return part.type === 'text' ? textTokens(part.text) : ATTACHMENT_TOKENS;
}

function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
