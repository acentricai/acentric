// A conversation's messages. Assistant messages are the provider's own output,
// kept as it is and sent back unchanged; everything else is shared.

import type { Json } from '@acentric/types';

import type { ContentPart, TextPart } from './content.js';
import type { Metadata, ProviderFields } from './fields.js';
import type { ApiOf, NativeInputItem, NativeOutputItem, Provider } from './providers.js';
import type { ToolType } from './tools.js';

type MessageBase = {
  /** For an assistant message, the provider's response ID. Otherwise the application's. */
  readonly id?: string;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp?: number;
  /** The application's own attributes. Never sent to a provider. */
  readonly metadata?: Metadata;
};

export type UserMessage = MessageBase & {
  readonly role: 'user';
  readonly content: readonly ContentPart[];
};

/**
 * An instruction in the middle of the conversation. The request's
 * `instructions` are the top-level ones. A provider with no such messages
 * refuses a request that has one.
 */
export type SystemMessage = MessageBase & {
  readonly role: 'system';
  readonly content: readonly TextPart[];
};

/**
 * The provider's output, as it is, for sending back: reasoning, signatures and
 * compaction items included. Read it with `outputText`, `toolCalls` and the
 * other readers. Sending it back is safe to the same provider, format and model.
 */
export type AssistantMessage<P extends Provider = Provider> = P extends Provider
  ? MessageBase & {
      readonly role: 'assistant';
      readonly provider: P;
      readonly api: ApiOf<P>;
      /** The model ID the request asked for. */
      readonly model: string;
      readonly content: readonly NativeOutputItem<P>[];
    }
  : never;

/** The result of a tool call the caller ran. */
export type ToolResultMessage = MessageBase & {
  readonly role: 'tool_result';
  readonly toolCallId: string;
  readonly toolName: string;
  /** The type of the tool that was called. Defaults to `function`. */
  readonly toolType?: ToolType;
  readonly content: readonly ContentPart[];
  /**
   * The tool failed. Sent only where the provider has a field for it, so
   * `content` must say what failed either way.
   */
  readonly isError?: boolean;
  /**
   * Merged into the provider's result item, for fields it requires on results,
   * such as OpenAI's `caller`. `toolResult(call, content)` copies them from the call.
   */
  readonly providerOptions?: ProviderFields;
};

/**
 * Input only provider `P` takes, sent as it is: a compaction trigger, the
 * output of a computer-use call, an approval.
 */
export type NativeMessage<P extends Provider = Provider> = P extends Provider
  ? MessageBase & {
      readonly role: 'native';
      readonly provider: P;
      readonly api: ApiOf<P>;
      readonly content: readonly NativeInputItem<P>[];
    }
  : never;

/** The application's own entry in a conversation. Never sent to a provider. */
export type CustomMessage = MessageBase & {
  readonly role: 'custom';
  /** Says how the application reads `data`. */
  readonly tag: string;
  readonly data: Json;
};

/** A message a request to provider `P` sends. */
export type RequestMessage<P extends Provider = Provider> =
  UserMessage | SystemMessage | ToolResultMessage | AssistantMessage<P> | NativeMessage<P>;

/** Any message in a conversation, the application's own included. */
export type Message<P extends Provider = Provider> = RequestMessage<P> | CustomMessage;

export type Role = Message['role'];
