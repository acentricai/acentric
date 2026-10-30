// What a model call sees once older history is summarised: the summary, as
// a user message, then the conversation from the first kept entry.

import type { Message, UserMessage } from '@acentric/llm';
import type { LogEntry } from '@acentric/types';

import { conversationMessages } from '../core/conversation.js';
import { logOf } from '../core/log.js';
import type { ContextRefs } from './kinds.js';
import type { CompactionEntries } from './log.js';

const compactions = logOf<CompactionEntries>();

/** The messages a model call reads from `entries`, which hold every entry `refs` names. */
export function context(entries: readonly LogEntry[], refs: ContextRefs): Message[] {
  const range = entries.filter((entry) => entry.seq >= refs.fromSeq && entry.seq < refs.toSeq);
  const summary =
    refs.summarySeq === null ? null : compactions.entryAt(entries, refs.summarySeq, 'compaction');
  const conversation = conversationMessages(range);
  return summary === null ? conversation : [summaryMessage(summary.body.summary), ...conversation];
}

export function summaryMessage(summary: string): UserMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `The conversation before this point was summarised to save space:\n\n<summary>\n${summary}\n</summary>`,
      },
    ],
  };
}
