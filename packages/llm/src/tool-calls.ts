// A tool call as the readers report it: a view of an item in an assistant
// message, which keeps the call itself.

import type { ProviderFields } from './fields.js';
import type { NativeOutputItem, Provider } from './providers.js';

export type ToolCall<P extends Provider = Provider> = P extends Provider
  ? {
      /** The ID a result answers. */
      readonly toolCallId: string;
      /** The tool's name, or the item type for a provider-defined tool without one. */
      readonly toolName: string;
      /**
       * `function` and `custom` calls are answered with a `tool_result` message,
       * `native` ones (a provider-defined tool such as computer use, or an
       * approval request) with a `native` message.
       */
      readonly toolType: 'function' | 'custom' | 'native';
      /** A function call's arguments as the model wrote them: a JSON string, not parsed. */
      readonly arguments?: string;
      /** A custom tool call's text. */
      readonly input?: string;
      readonly namespace?: string;
      /** The call may stay unanswered while the conversation goes on. */
      readonly async?: boolean;
      /** Fields the provider requires on this call's result; `toolResult` copies them. */
      readonly resultOptions?: ProviderFields;
      /** The provider's item type, such as `function_call` or `tool_use`. */
      readonly itemType: string;
      /** The call as the provider wrote it. */
      readonly item: NativeOutputItem<P>;
    }
  : never;
