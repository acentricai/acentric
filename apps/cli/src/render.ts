// A conversation, as the command prints it: a line for what each message says, and a line for
// each tool a model called.
//
// A model's answer is its provider's own output, which this command does not know the shape
// of. It is read for what every provider's output has in some form: text, and calls of tools.

import type { ContentPart, ConversationEntry, Json, TurnEnd } from '@acentric/protocol';

type Dict = { readonly [key: string]: Json };

const isDict = (value: Json | undefined): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The arguments of a call, on one line. */
function argumentsOf(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** What a part of a user's message or of a tool's result says. */
function partText(part: ContentPart): string {
  if (part.type === 'text') return part.text;
  const { source } = part;
  const named = part.type === 'file' && part.filename !== undefined ? ` ${part.filename}` : '';
  if (source.type === 'blob') {
    return `[${part.type}${named}: ${source.mediaType}, ${String(source.size)} bytes, blob ${source.digest}]`;
  }
  if (source.type === 'base64') return `[${part.type}${named}: ${source.mediaType}]`;
  return `[${part.type}${named}: ${source.type === 'url' ? source.url : source.id}]`;
}

/** What one item of a model's output says: its text, or the tool it calls. Nothing for the rest. */
function itemLines(item: Dict): string[] {
  const { type } = item;
  if ((type === 'text' || type === 'output_text') && typeof item['text'] === 'string') {
    return item['text'] === '' ? [] : [item['text']];
  }
  if (type === 'message' && Array.isArray(item['content'])) {
    return item['content'].flatMap((inner) => (isDict(inner) ? itemLines(inner) : []));
  }
  if (typeof item['name'] === 'string' && typeof type === 'string' && /call|tool_use/.test(type)) {
    return [`→ ${item['name']}(${argumentsOf(item['input'] ?? item['arguments'])})`];
  }
  return [];
}

/** The lines an entry of a conversation is printed as, each with who said it. */
export function entryLines(entry: ConversationEntry): string[] {
  const { message } = entry;
  const at = `#${String(entry.seq)}`;
  const said = (who: string, lines: readonly string[]): string[] =>
    (lines.length === 0 ? [''] : lines).map((line) => `${at} ${who}: ${line}`.trimEnd());
  switch (message.role) {
    case 'user':
    case 'system':
      return said(message.role, [message.content.map(partText).join(' ')]);
    case 'assistant': {
      const lines = message.content.flatMap(itemLines);
      const stopped = entry.completion?.stopReason;
      const why =
        stopped === undefined || stopped === 'stop' || stopped === 'tool_use'
          ? []
          : [`(stopped: ${stopped})`];
      return said('assistant', [...lines, ...why]);
    }
    case 'tool_result': {
      const text = message.content.map(partText).join(' ');
      return said(`${message.toolName}${message.isError === true ? ' failed' : ''}`, [text]);
    }
    case 'native':
      return said(message.provider, [
        `[${message.content.map((item) => String(item['type'] ?? 'item')).join(', ')}]`,
      ]);
    case 'custom':
      return said(message.tag, [JSON.stringify(message.data)]);
  }
}

/** How a turn ended, in a few words. */
export function turnText(turn: TurnEnd): string {
  return turn.reason === undefined ? turn.end : `${turn.end}: ${turn.reason}`;
}

/** Rows as a table: each column as wide as its widest cell. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = head.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)];
}
