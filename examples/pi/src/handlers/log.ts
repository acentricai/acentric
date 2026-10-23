// Reading the agent's log from a handler.

import type { LogEntry, LogReader } from '@acentric/types';

import type { ToolCallBlock } from '../content.js';
import { isKind } from '../entries.js';
import type { Entry } from '../entries.js';
import type { PiLogKind } from '../log.js';

/** Every entry with a seq in [fromSeq, toSeq), oldest first, reading page by page. */
export async function readRange(
  log: LogReader,
  fromSeq: number,
  toSeq: number,
  cursor?: string,
): Promise<LogEntry[]> {
  // Each page needs the previous page's cursor, so pages are read one after another.
  const page = await log.list({
    after: fromSeq - 1,
    before: toSeq,
    ...(cursor === undefined ? {} : { cursor }),
  });
  if (page.cursor === undefined) return [...page.entries];
  return [...page.entries, ...(await readRange(log, fromSeq, toSeq, page.cursor))];
}

/** The entry at `seq`, which must be of `kind`. */
export async function readEntry<K extends PiLogKind>(
  log: LogReader,
  seq: number,
  kind: K,
): Promise<Entry<K>> {
  const page = await log.list({ after: seq - 1, before: seq + 1, limit: 1 });
  const entry = page.entries[0];
  if (entry === undefined || !isKind(entry, kind))
    throw new Error(`log entry ${seq} is not a ${kind} entry`);
  return entry;
}

/** The tool call `toolCallId` in the assistant entry at `seq`. */
export async function readToolCall(
  log: LogReader,
  seq: number,
  toolCallId: string,
): Promise<ToolCallBlock> {
  const reply = await readEntry(log, seq, 'assistant');
  const call = reply.body.content.find(
    (block): block is ToolCallBlock => block.type === 'toolCall' && block.id === toolCallId,
  );
  if (call === undefined) throw new Error(`log entry ${seq} has no tool call ${toolCallId}`);
  return call;
}
