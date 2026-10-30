// What the summary call is told: summarise the conversation so the work can
// go on from the summary and the newest messages alone, extending the
// previous summary when there is one.

import type { Message, UserMessage } from '@acentric/llm';

export const SUMMARY_INSTRUCTIONS = `You summarise a conversation between a user and an AI assistant so the assistant can carry on with only your summary and the newest messages. Keep what the assistant needs to continue: the user's goals and requests, decisions made and why, what was done and what it found (files, commands, results, errors), what is still open, and anything the user asked to remember. Be specific and concise. Write the summary only, with no preamble.`;

/** The conversation to summarise, then the request, extending `previous` if there is one. */
export function summaryMessages(
  conversation: readonly Message[],
  previous: string | null,
): Message[] {
  return [...conversation, request(previous)];
}

function request(previous: string | null): UserMessage {
  const text =
    previous === null
      ? 'Summarise the conversation above.'
      : `Summarise the conversation above, extending this summary of what came before it:\n\n<summary>\n${previous}\n</summary>`;
  return { role: 'user', content: [{ type: 'text', text }] };
}
