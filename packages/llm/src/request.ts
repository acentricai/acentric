// What a handler asks the client for. It holds no credentials: the client
// reads them from the handler's secrets, so they never reach args or the log.

import type { TextPart } from './content.js';
import type { Message } from './messages.js';
import type { ModelId, Provider, ProviderOptions } from './providers.js';
import type { ToolDefinition } from './tools.js';

/**
 * One completion from provider `P`. Distributes over providers, so the model
 * IDs, options and messages sent back all belong to `provider`.
 */
export type LlmRequest<P extends Provider = Provider> = P extends Provider
  ? {
      readonly provider: P;
      readonly model: ModelId<P>;
      /** The provider's top-level system instructions. */
      readonly instructions?: string | readonly TextPart[];
      /** The conversation. `custom` messages are left out when sending. */
      readonly messages: readonly Message<P>[];
      /** Tools the caller runs. Hosted tools go in `options.tools`. */
      readonly tools?: readonly ToolDefinition[];
      /** The provider's own request fields, passed through. */
      readonly options?: ProviderOptions<P>;
      /** The most the call may take, in milliseconds. */
      readonly timeoutMs?: number;
    }
  : never;
