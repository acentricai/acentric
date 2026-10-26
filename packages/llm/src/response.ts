// What a completion returns, the same for every provider apart from the
// assistant message and `native`, which are the provider's own.

import type { AssistantMessage } from './messages.js';
import type { ModelId, NativeResponse, Provider } from './providers.js';
import type { Usage } from './usage.js';

export type StopReason =
  /** Generation ended normally, a stop sequence included. */
  | 'stop'
  /** Cut short by an output token or length limit. */
  | 'length'
  /** The model called tools for the caller to run. */
  | 'tool_use'
  /** The model declined. */
  | 'refusal'
  /** A provider's safety filter blocked or ended generation. */
  | 'content_filter'
  /** The provider paused a turn that can be continued, such as during a long server tool run. */
  | 'pause_turn';

/** One completion from provider `P`. */
export type LlmResponse<P extends Provider = Provider> = P extends Provider
  ? {
      /** The provider's response ID, such as for `previous_response_id`. */
      readonly id?: string;
      readonly provider: P;
      /** The model ID the request asked for. */
      readonly model: ModelId<P>;
      /** The model the provider says answered, when it differs. */
      readonly responseModel?: string;
      readonly message: AssistantMessage<P>;
      readonly stopReason: StopReason;
      /** The provider's own reason, as it is, when it says more than `stopReason`. */
      readonly providerStopReason?: string;
      readonly usage?: Usage;
      /** The provider's response fields that say something new: not its output or echoes of the request. */
      readonly native: NativeResponse<P>;
      /** How long the provider took, in milliseconds. */
      readonly durationMs: number;
      /** When the response arrived, in milliseconds since the Unix epoch. */
      readonly timestamp: number;
    }
  : never;
