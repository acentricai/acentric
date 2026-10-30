// Reading a run of the log from a handler, every page of it. Handlers read
// the log rather than take copies in their args, which stay small.

import type { LogEntry, LogReader } from '@acentric/types';

/** The entries with fromSeq <= seq < toSeq, oldest first. */
export async function readEntries(
  log: LogReader,
  fromSeq: number,
  toSeq: number,
  cursor?: string,
): Promise<LogEntry[]> {
  const page = await log.list({
    after: fromSeq - 1,
    before: toSeq,
    ...(cursor === undefined ? {} : { cursor }),
  });
  if (page.cursor === undefined) return [...page.entries];
  return [...page.entries, ...(await readEntries(log, fromSeq, toSeq, page.cursor))];
}

/** The entry at `seq`, if the log has it. */
export async function readEntry(log: LogReader, seq: number): Promise<LogEntry | null> {
  const [entry] = await readEntries(log, seq, seq + 1);
  return entry ?? null;
}
