// Readers over any provider's assistant message, and the helpers that build
// what a request sends. Each reader goes to its message's API format. Pure:
// a step can use them.

import type { Json } from '@acentric/types';

import type { ContentPart } from './content.js';
import type { AssistantMessage, Message, RequestMessage, ToolResultMessage } from './messages.js';
import type { Provider } from './providers.js';
import * as anthropic from './read/anthropic.js';
import * as responses from './read/responses.js';
import type { ReadCall, TextOptions } from './read/responses.js';
import type { ToolCall } from './tool-calls.js';

export type { TextOptions } from './read/responses.js';

/** The message's items, read as plain Json. */
function items(message: AssistantMessage): readonly Json[] {
  return message.content;
}

/** Typed for the message's provider: a reader returns that message's own items. */
function typed<P extends Provider>(calls: readonly ReadCall[]): ToolCall<P>[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return calls as unknown as ToolCall<P>[];
}

/**
 * The text of the message's answer. On the Responses format, messages are
 * joined by a blank line and commentary is left out unless `{ phase: 'all' }`.
 */
export function outputText(message: AssistantMessage, options?: TextOptions): string {
  return message.api === 'anthropic-messages'
    ? anthropic.outputText(items(message))
    : responses.outputText(items(message), options);
}

/** What the model refused to do, in order. Anthropic says so in the stop reason instead, so its messages have none. */
export function refusals(message: AssistantMessage): string[] {
  return message.api === 'anthropic-messages'
    ? anthropic.refusals()
    : responses.refusals(items(message));
}

/** Reasoning summaries or thinking texts, in order. Encrypted reasoning stays in the message. */
export function reasoningSummary(message: AssistantMessage): string[] {
  return message.api === 'anthropic-messages'
    ? anthropic.reasoningSummary(items(message))
    : responses.reasoningSummary(items(message));
}

/** Every call in the message that the caller answers, answered within it or not. */
export function toolCalls<P extends Provider>(message: AssistantMessage<P>): ToolCall<P>[] {
  const any: AssistantMessage = message;
  return typed<P>(
    any.api === 'anthropic-messages'
      ? anthropic.toolCalls(items(any))
      : responses.toolCalls(items(any)),
  );
}

/** Calls the caller still has to answer. An async call may stay pending while the conversation goes on. */
export function pendingToolCalls<P extends Provider>(message: AssistantMessage<P>): ToolCall<P>[] {
  const any: AssistantMessage = message;
  return typed<P>(
    any.api === 'anthropic-messages'
      ? anthropic.toolCalls(items(any))
      : responses.pendingToolCalls(items(any)),
  );
}

export type ToolResultOptions = {
  /** Sent only where the provider has a field for it, so the content must say what failed. */
  readonly isError?: boolean;
};

/**
 * The message answering a `function` or `custom` call, with the fields the
 * provider requires on its result, such as OpenAI's `caller`. A `native` call
 * is answered with a `native` message instead.
 */
export function toolResult(
  call: ToolCall,
  content: string | readonly ContentPart[],
  { isError }: ToolResultOptions = {},
): ToolResultMessage {
  if (call.toolType === 'native') {
    throw new TypeError(
      `${call.itemType} is a provider-defined call: answer it with a native message`,
    );
  }
  return {
    role: 'tool_result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    toolType: call.toolType,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    ...(isError === undefined ? {} : { isError }),
    ...(call.resultOptions === undefined ? {} : { providerOptions: call.resultOptions }),
  };
}

/** The messages a provider receives: the application's own `custom` messages left out. */
export function requestMessages<P extends Provider>(
  messages: readonly Message<P>[],
): RequestMessage<P>[] {
  return messages.filter((message): message is RequestMessage<P> => message.role !== 'custom');
}
