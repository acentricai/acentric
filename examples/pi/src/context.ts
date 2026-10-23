// What the model sees: a pure projection of log entries, shared by step (to
// estimate the context size) and the llm handler (to make the call).
//
// It is the latest compaction's summary, as a user message, then the
// `user`, `assistant` and `tool_result` entries in order, leaving out
// entries an `omit` names and every other kind. Tool results are put in the
// order their reply made the calls, whatever order they finished in, so
// every result directly follows its call.

import type { LogEntry } from '@acentric/types';

import type {
  AssistantMessage,
  ImageBlock,
  TextBlock,
  ThinkingLevel,
  ToolResult,
} from './content.js';
import { isKind } from './entries.js';

export type ContextMessage =
  | { role: 'user'; content: (TextBlock | ImageBlock)[] }
  | ({ role: 'assistant'; thinkingLevel: ThinkingLevel } & AssistantMessage)
  | ({ role: 'toolResult'; toolCallId: string; toolName: string } & ToolResult);

/** How pi presents a compaction summary to the model. */
export function summaryMessage(summary: string): ContextMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
      },
    ],
  };
}

/**
 * The messages the model sees for `entries`, after `summary` if there is
 * one. `entries` should start at the latest compaction's first kept entry.
 */
export function buildContext(
  entries: readonly LogEntry[],
  summary: string | null,
): ContextMessage[] {
  const omitted = new Set<number>();
  for (const entry of entries) if (isKind(entry, 'omit')) omitted.add(entry.body.seq);

  const messages: ContextMessage[] = summary === null ? [] : [summaryMessage(summary)];
  // Results of the latest reply's calls, held until the next message so they
  // can be put in call order.
  let callOrder: string[] = [];
  let results: ContextMessage[] = [];
  const flush = (): void => {
    messages.push(
      ...results.toSorted((a, b) => callPosition(a, callOrder) - callPosition(b, callOrder)),
    );
    results = [];
  };

  for (const entry of entries) {
    if (omitted.has(entry.seq)) continue;
    if (isKind(entry, 'tool_result')) {
      results.push({ role: 'toolResult', ...entry.body });
    } else if (isKind(entry, 'assistant')) {
      flush();
      messages.push({ role: 'assistant', ...entry.body });
      callOrder = entry.body.content.flatMap((block) =>
        block.type === 'toolCall' ? [block.id] : [],
      );
    } else if (isKind(entry, 'user')) {
      flush();
      messages.push({ role: 'user', content: entry.body.content });
    }
  }
  flush();
  return messages;
}

/** Where a tool result goes among its reply's calls; results without a call go last. */
function callPosition(message: ContextMessage, callOrder: string[]): number {
  const index = message.role === 'toolResult' ? callOrder.indexOf(message.toolCallId) : -1;
  return index === -1 ? callOrder.length : index;
}
