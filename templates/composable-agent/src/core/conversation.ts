// What the model sees of a run of log entries: its user messages, replies
// and tool results, in order, and nothing else. Tool results are appended
// as calls finish; the model gets them back in the order of the reply's
// calls, as the providers expect.

import { toolCalls } from '@acentric/llm';
import type { Message, ToolResultMessage } from '@acentric/llm';
import type { LogEntry } from '@acentric/types';

import { logOf } from './log.js';
import type { ConversationEntries } from './log.js';

const conversation = logOf<ConversationEntries>();

/** The messages the model sees in `entries`, oldest first. */
export function conversationMessages(entries: readonly LogEntry[]): Message[] {
  const messages: Message[] = [];
  let calls: string[] = [];
  let results: ToolResultMessage[] = [];
  const flush = (): void => {
    messages.push(...results.toSorted((a, b) => order(calls, a) - order(calls, b)));
    results = [];
  };
  for (const entry of entries) {
    if (conversation.isKind(entry, 'tool_result')) {
      results.push(entry.body);
    } else if (conversation.isKind(entry, 'assistant')) {
      flush();
      messages.push(entry.body.message);
      calls = toolCalls(entry.body.message).map((call) => call.toolCallId);
    } else if (conversation.isKind(entry, 'user')) {
      flush();
      messages.push(entry.body);
    }
  }
  flush();
  return messages;
}

/** Where a result's call came in its reply; results for calls it did not make go last. */
function order(calls: readonly string[], result: ToolResultMessage): number {
  const index = calls.indexOf(result.toolCallId);
  return index === -1 ? calls.length : index;
}
