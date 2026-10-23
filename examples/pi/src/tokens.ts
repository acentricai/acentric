// Estimating the context size, in tokens, the way pi does: the latest
// reply's reported usage, plus about one token per four characters of what
// came after it. Reported usage from before the latest compaction or omit no
// longer describes the context, so then everything is estimated.

import type { LogEntry } from '@acentric/types';

import type { Usage } from './content.js';
import { isKind } from './entries.js';
import { systemPrompt } from './prompt.js';

/** pi counts an image as this many characters. */
const IMAGE_CHARS = 4800;

/** The tokens one usage report says the context took. */
export function usageTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The estimated tokens of one entry the model sees; zero for every other kind. */
export function entryTokens(entry: LogEntry): number {
  let chars = 0;
  if (isKind(entry, 'user') || isKind(entry, 'tool_result')) {
    for (const block of entry.body.content)
      chars += block.type === 'text' ? block.text.length : IMAGE_CHARS;
  } else if (isKind(entry, 'assistant')) {
    for (const block of entry.body.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'thinking') chars += block.thinking.length;
      else chars += block.name.length + JSON.stringify(block.arguments).length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * The estimated size of the context the next model call would get:
 * `entries` from the latest compaction's first kept entry, the summary, and
 * the system prompt.
 */
export function estimateContext(
  entries: readonly LogEntry[],
  summary: string | null,
  cwd: string,
): number {
  const omitted = new Set<number>();
  let invalidatedAt = 0;
  for (const entry of entries) {
    if (isKind(entry, 'omit')) {
      omitted.add(entry.body.seq);
      invalidatedAt = entry.seq;
    } else if (isKind(entry, 'compaction')) {
      invalidatedAt = entry.seq;
    }
  }
  const visible = entries.filter((entry) => !omitted.has(entry.seq));

  for (let index = visible.length - 1; index >= 0; index--) {
    const entry = visible[index];
    if (entry === undefined || !isKind(entry, 'assistant')) continue;
    const { stopReason, usage } = entry.body;
    if (stopReason === 'error' || stopReason === 'aborted' || usageTokens(usage) === 0) continue;
    if (entry.seq < invalidatedAt) break;
    return (
      usageTokens(usage) +
      visible.slice(index + 1).reduce((sum, after) => sum + entryTokens(after), 0)
    );
  }

  return (
    textTokens(systemPrompt(cwd)) +
    (summary === null ? 0 : textTokens(summary)) +
    visible.reduce((sum, entry) => sum + entryTokens(entry), 0)
  );
}
