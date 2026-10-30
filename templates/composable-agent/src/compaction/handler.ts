// The summarize handler: the compaction part's I/O, imported by handlers.ts
// and never by the agent. It reads the entries to summarise and the summary
// they extend from the log, and asks the summary model for a new one.

import { outputText } from '@acentric/llm';
import { createLlm } from '@acentric/llm/client';
import type { LlmOptions } from '@acentric/llm/client';
import type { HandlerDef } from '@acentric/types';

import { conversationMessages } from '../core/conversation.js';
import { logOf } from '../core/log.js';
import { readEntries, readEntry } from '../core/read.js';
import { requestFor } from '../core/request.js';
import type { SummarizeArgs, Summary } from './kinds.js';
import type { CompactionEntries } from './log.js';
import { SUMMARY_INSTRUCTIONS, summaryMessages } from './prompt.js';

const compactions = logOf<CompactionEntries>();

/** `options` are @acentric/llm's, such as a fetch for tests. */
export function summarizeHandler(options: LlmOptions = {}): HandlerDef<SummarizeArgs, Summary> {
  return {
    mode: 'reissue',
    run: async (ctx) => {
      const { model, fromSeq, toSeq, previousSummarySeq } = ctx.args;
      const entries = await readEntries(ctx.log, fromSeq, toSeq);
      const previous =
        previousSummarySeq === null ? null : await readEntry(ctx.log, previousSummarySeq);
      const summary =
        previous !== null && compactions.isKind(previous, 'compaction')
          ? previous.body.summary
          : null;
      const request = requestFor(model, {
        instructions: SUMMARY_INSTRUCTIONS,
        messages: summaryMessages(conversationMessages(entries), summary),
      });
      const response = await createLlm(ctx, options).complete(request);
      return { summary: outputText(response.message), usage: response.usage ?? null };
    },
  };
}
