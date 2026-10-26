// Fireworks AI's Responses API: its credentials, request options, items beyond
// the shared Responses format, and the response fields kept in `native`.
// Fireworks accepts request fields it does not know and ignores them, so these
// types are the only check on them.

import type { JsonObject } from '@acentric/types';

import type {
  ResponsesCompaction,
  ResponsesCustomToolCall,
  ResponsesCustomToolCallOutput,
  ResponsesInputItem,
  ResponsesItem,
  ResponsesOutputItem,
  ResponsesStatus,
} from '../formats/responses.js';

export type FireworksCredentials = {
  /** A Fireworks API key, `fw_...`, sent as `Authorization: Bearer`. */
  readonly apiKey: string;
};

/** Hosted tools: Fireworks runs them, and their results are in the same output. */
export type FireworksMcpCall = ResponsesItem<
  'mcp_call',
  { readonly status?: string; readonly server_label?: string; readonly name?: string }
>;
export type FireworksWebSearchCall = ResponsesItem<'web_search_call', { readonly status?: string }>;

/** Fireworks has no custom tools and no compaction. */
type SharedOutputItem = Exclude<ResponsesOutputItem, ResponsesCustomToolCall | ResponsesCompaction>;

export type FireworksOutputItem = SharedOutputItem | FireworksMcpCall | FireworksWebSearchCall;

/** An item a `native` message may carry. */
export type FireworksInputItem =
  | Exclude<
      ResponsesInputItem,
      ResponsesCustomToolCall | ResponsesCustomToolCallOutput | ResponsesCompaction
    >
  | FireworksOutputItem;

// ---- Request options: the Responses request body, less `model`, `input` and
// `instructions`, which the request owns.

/**
 * What a model takes depends on the model: gpt-oss only low, medium and high;
 * GLM cannot turn reasoning off. A value a model does not take is refused.
 */
export type FireworksReasoningEffort =
  'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});

/** A native tool definition: functions, remote MCP or SSE servers, web search, namespaces. */
export type FireworksTool = JsonObject & {
  readonly type: 'function' | 'mcp' | 'sse' | 'web_search' | 'namespace' | (string & {});
};

export type FireworksTextFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly name: string;
      readonly schema: JsonObject;
      readonly description?: string;
      readonly strict?: boolean | null;
    };

export type FireworksOptions = {
  /** Hosted and other native tools, sent after the request's own. */
  readonly tools?: readonly FireworksTool[];
  readonly tool_choice?: 'none' | 'auto' | 'required' | (JsonObject & { readonly type: string });
  readonly parallel_tool_calls?: boolean | null;
  /** Caps calls to hosted tools. */
  readonly max_tool_calls?: number | null;
  /** Covers visible output and reasoning. */
  readonly max_output_tokens?: number | null;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly top_logprobs?: number | null;
  /** The reasoning text always comes back; its summary cannot be set. */
  readonly reasoning?: { readonly effort?: FireworksReasoningEffort | null } | null;
  /** A JSON schema turns reasoning off on some models. */
  readonly text?: { readonly format?: FireworksTextFormat } | null;
  /**
   * Defaults to `true` at Fireworks: the response is kept for 30 days.
   * Zero-data-retention accounts must send `false`.
   */
  readonly store?: boolean | null;
  /** Only `message.output_text.logprobs`: there is no encrypted reasoning. */
  readonly include?: readonly ('message.output_text.logprobs' | (string & {}))[] | null;
  /**
   * Continues from a stored response, so only the new messages are sent.
   * Instructions and tools are not inherited.
   */
  readonly previous_response_id?: string | null;
  readonly metadata?: { readonly [key: string]: string } | null;
  readonly truncation?: 'auto' | 'disabled' | null;
  /** Sends requests to the same replica, for more prompt-cache hits. */
  readonly prompt_cache_key?: string | null;
  readonly user?: string | null;
  readonly service_tier?: 'default' | 'priority' | (string & {}) | null;
  /** The client returns one finished response, so `true` is refused. */
  readonly stream?: false | null;
  /** The client returns one finished response, so `true` is refused. */
  readonly background?: false | null;
};

/** The response's own fields, kept in `native`. Fireworks echoes nearly every request field; those are left out. */
export type FireworksNativeResponse = JsonObject & {
  readonly status: ResponsesStatus;
  readonly created_at?: number;
  readonly incomplete_details?: { readonly reason?: string } | null;
};

/** Model IDs the types know. Any other model, deployment or router ID works too. */
export type FireworksModelId =
  | 'accounts/fireworks/models/kimi-k3'
  | 'accounts/fireworks/routers/kimi-k3-fast'
  | 'accounts/fireworks/models/ember-1'
  | 'accounts/fireworks/models/deepseek-v4p1-flash'
  | 'accounts/fireworks/models/glm-5p3'
  | 'accounts/fireworks/routers/glm-5p3-fast'
  | 'accounts/fireworks/models/glm-5p3-flash'
  | 'accounts/fireworks/models/qwen3p8-max'
  | 'accounts/fireworks/models/minimax-m3'
  | 'accounts/fireworks/models/gpt-oss-120b'
  | 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b'
  | 'accounts/fireworks/models/nemotron-3-ultra-nvfp4'
  | 'accounts/fireworks/models/inkling';

export type FireworksSpec = {
  readonly api: 'openai-responses';
  readonly credentials: FireworksCredentials;
  readonly options: FireworksOptions;
  readonly inputItem: FireworksInputItem;
  readonly outputItem: FireworksOutputItem;
  readonly response: FireworksNativeResponse;
  readonly modelId: FireworksModelId;
};
