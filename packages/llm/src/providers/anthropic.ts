// Anthropic's Messages API: its credentials, request options and the response
// fields kept in `native`. Anthropic refuses fields it does not know, so a typo
// never passes silently.

import type { JsonObject } from '@acentric/types';

import type {
  AnthropicCacheControl,
  AnthropicInputBlock,
  AnthropicOutputBlock,
  AnthropicUsage,
} from '../formats/anthropic.js';

export type AnthropicCredentials = {
  /** An Anthropic API key, sent as `x-api-key`. */
  readonly apiKey: string;
  /** Sent as `anthropic-workspace-id`, which keys that span workspaces require. */
  readonly workspaceId?: string;
};

/**
 * `adaptive` lets the model decide, and is the default on Claude 5 models.
 * Whether thinking can be turned off depends on the model; budgeted
 * (`enabled`) thinking is refused by every Claude 5 model.
 */
export type AnthropicThinking =
  | {
      readonly type: 'adaptive';
      /** `omitted`, the default, returns empty thinking text; `summarized` returns a summary. */
      readonly display?: 'summarized' | 'omitted' | (string & {});
      readonly block_binding?: { readonly prefix_mismatch_behavior: 'error' | 'drop_block' };
    }
  | { readonly type: 'disabled' }
  | { readonly type: 'between_tools' }
  | { readonly type: 'enabled'; readonly budget_tokens: number };

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});

export type AnthropicToolChoice =
  | { readonly type: 'auto'; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: 'any'; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: 'tool'; readonly name: string; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: 'none' };

/** A native tool: a server tool, such as `web_search_20260209`, or an Anthropic-defined client tool. */
export type AnthropicTool = JsonObject & {
  readonly type?: string;
  readonly name: string;
};

export type AnthropicOptions = {
  /**
   * The output limit, thinking included. Defaults to the model's maximum
   * (128,000 on Claude 5 models, and for models the client does not know).
   */
  readonly max_tokens?: number;
  /** Sent as the `anthropic-beta` header. A name Anthropic does not know refuses the request. */
  readonly betas?: readonly string[];
  readonly thinking?: AnthropicThinking;
  readonly output_config?: JsonObject & {
    readonly effort?: AnthropicEffort;
    /** Structured output; refused with citations. */
    readonly format?: { readonly type: 'json_schema'; readonly schema: JsonObject };
  };
  /** Server tools and Anthropic-defined client tools, sent after the request's own. */
  readonly tools?: readonly AnthropicTool[];
  readonly tool_choice?: AnthropicToolChoice;
  readonly stop_sequences?: readonly string[];
  /** An opaque user ID for abuse detection; never an email or other personal data. */
  readonly metadata?: { readonly user_id?: string };
  /** `auto` uses Priority Tier where the organization has it. */
  readonly service_tier?: 'auto' | 'standard_only';
  /** `us` keeps inference in the US, at 1.1 times the price. */
  readonly inference_geo?: 'global' | 'us' | (string & {});
  /** Automatic caching: one breakpoint on the last block that can be cached. */
  readonly cache_control?: AnthropicCacheControl;
  /** A code execution container to reuse, by ID, or `{ id?, skills? }`. */
  readonly container?: string | JsonObject;
  /** Clearing tool uses or thinking, and compaction past a threshold. */
  readonly context_management?: JsonObject;
  /** Compaction on request. */
  readonly compaction?: JsonObject;
  /** Remote MCP servers. May hold secrets. */
  readonly mcp_servers?: readonly JsonObject[];
  readonly speed?: 'standard' | 'fast';
  /** Retrying on another model after a refusal. */
  readonly fallbacks?: 'default' | readonly JsonObject[];
  readonly diagnostics?: { readonly previous_message_id: string | null };
  /** Claude 5 models take only the defaults: `temperature: 1`, `top_p` 0.99 or more. */
  readonly temperature?: number;
  readonly top_p?: number;
  /** The client returns one finished response, so `true` is refused. */
  readonly stream?: false;
};

/**
 * The response's own fields, kept in `native`: the stop sequence that matched,
 * why it stopped in more detail (a refusal's category), the code execution
 * container, context management, and the usage fields `usage` does not hold
 * (cache writes by time to live, service tier, where inference ran, speed,
 * server tool counts, iterations).
 */
export type AnthropicNativeResponse = JsonObject & {
  readonly stop_sequence?: string;
  readonly stop_details?: JsonObject & { readonly category?: string | null };
  readonly container?: { readonly id: string; readonly expires_at?: string };
  readonly context_management?: JsonObject;
  readonly diagnostics?: JsonObject;
  readonly usage?: Omit<
    AnthropicUsage,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens'
    | 'output_tokens_details'
  >;
};

/** Model IDs the types know. Any other works too. */
export type AnthropicModelId =
  | 'claude-fable-5-1'
  | 'claude-opus-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-haiku-5-5'
  | 'claude-fable-5'
  | 'claude-opus-5'
  | 'claude-sonnet-5';

export type AnthropicSpec = {
  readonly api: 'anthropic-messages';
  readonly credentials: AnthropicCredentials;
  readonly options: AnthropicOptions;
  readonly inputItem: AnthropicInputBlock;
  readonly outputItem: AnthropicOutputBlock;
  readonly response: AnthropicNativeResponse;
  readonly modelId: AnthropicModelId;
};
