// The Anthropic Messages format (`POST /v1/messages`): the content blocks the
// client writes and reads.
//
// Blocks are typed for what the client and the readers interpret. Anthropic
// adds block types and fields often, and those pass through as they are.

import type { Json } from '@acentric/types';

/** A prompt-cache breakpoint on a block, tool or system text. */
export type AnthropicCacheControl = {
  readonly type: 'ephemeral';
  /** `5m`, the default, or `1h`, which costs twice the input price to write. */
  readonly ttl?: '5m' | '1h';
};

/** A block typed loosely: only the fields the readers use are named, and the rest pass through. */
export type AnthropicBlock<T extends string, Fields = unknown> = {
  readonly type: T;
  readonly [key: string]: Json;
} & Fields;

// ---- Output blocks: an assistant message's content, sent back as it is.

export type AnthropicTextBlock = {
  readonly type: 'text';
  readonly text: string;
  /** Where the text comes from, with documents or search results that allow citations. */
  readonly citations?: readonly Json[] | null;
};

/**
 * The model's reasoning. `thinking` is a summary, or empty when `display` is
 * `omitted`, the default on Claude 5 models; the reasoning itself travels in
 * the `signature`, which is checked every time it is sent back. Send it back
 * unchanged.
 */
export type AnthropicThinkingBlock = {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature: string;
};

/** Reasoning the safety systems flagged, encrypted. Send it back unchanged. */
export type AnthropicRedactedThinkingBlock = {
  readonly type: 'redacted_thinking';
  readonly data: string;
};

/** Who made a call: `direct`, or code execution for programmatic tool calling. */
export type AnthropicCaller = { readonly type: string; readonly [key: string]: Json };

/** A call to one of the caller's tools, answered with a `tool_result`. */
export type AnthropicToolUseBlock = {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  /** The arguments, parsed. */
  readonly input: Json;
  readonly caller?: AnthropicCaller;
  /** Set on a member of an Anthropic toolset; its result must name the toolset. */
  readonly toolset_name?: string;
};

/** A call to a server tool: web search, web fetch, code execution, tool search. */
export type AnthropicServerToolUseBlock = AnthropicBlock<
  'server_tool_use',
  { readonly id: string; readonly name: string; readonly input: Json }
>;

/** A server tool's result, in the same message. Some hold encrypted content: send them back unchanged. */
export type AnthropicServerToolResultBlock = AnthropicBlock<
  | 'web_search_tool_result'
  | 'web_fetch_tool_result'
  | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result'
  | 'text_editor_code_execution_tool_result'
  | 'tool_search_tool_result',
  { readonly tool_use_id: string }
>;

/** A call to a remote MCP server, and its result. */
export type AnthropicMcpToolUseBlock = AnthropicBlock<'mcp_tool_use', { readonly id: string }>;
export type AnthropicMcpToolResultBlock = AnthropicBlock<
  'mcp_tool_result',
  { readonly tool_use_id: string }
>;

/** Earlier context, summarized. Send it back unchanged. */
export type AnthropicCompactionBlock = AnthropicBlock<'compaction'>;

/** A file uploaded to the code execution container. */
export type AnthropicContainerUploadBlock = AnthropicBlock<
  'container_upload',
  { readonly file_id: string }
>;

export type AnthropicOutputBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicServerToolUseBlock
  | AnthropicServerToolResultBlock
  | AnthropicMcpToolUseBlock
  | AnthropicMcpToolResultBlock
  | AnthropicCompactionBlock
  | AnthropicContainerUploadBlock;

// ---- Input blocks: what the client writes from shared content, and what a
// `native` message may carry, sent in a user turn.

export type AnthropicMediaSource =
  | { readonly type: 'base64'; readonly media_type: string; readonly data: string }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'file'; readonly file_id: string }
  | { readonly type: 'text'; readonly media_type: 'text/plain'; readonly data: string }
  | { readonly type: 'content'; readonly content: Json };

export type AnthropicImageBlock = AnthropicBlock<
  'image',
  { readonly source: AnthropicMediaSource }
>;
export type AnthropicDocumentBlock = AnthropicBlock<
  'document',
  { readonly source: AnthropicMediaSource }
>;
/** A search result the model may cite. */
export type AnthropicSearchResultBlock = AnthropicBlock<
  'search_result',
  { readonly source: string; readonly title: string; readonly content: readonly Json[] }
>;
export type AnthropicToolResultBlock = AnthropicBlock<
  'tool_result',
  { readonly tool_use_id: string; readonly is_error?: boolean }
>;

/** A block a `native` message may carry. */
export type AnthropicInputBlock =
  | AnthropicBlock<'text', { readonly text: string }>
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicSearchResultBlock
  | AnthropicToolResultBlock
  | AnthropicContainerUploadBlock;

/** Why generation stopped. */
export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | 'compaction'
  | (string & {});

/** Token usage as the format reports it. */
export type AnthropicUsage = {
  /** Uncached input only. */
  readonly input_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  /** Cache writes by time to live. */
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number;
    readonly ephemeral_1h_input_tokens?: number;
  } | null;
  /** Output tokens, thinking included. */
  readonly output_tokens: number;
  readonly output_tokens_details?: { readonly thinking_tokens?: number } | null;
  readonly server_tool_use?: { readonly [tool: string]: number } | null;
  /** The tier that served the request: `standard`, `priority` or `batch`. */
  readonly service_tier?: string | null;
  /** Where inference ran: `global`, or `us` at 1.1 times the price. */
  readonly inference_geo?: string | null;
  /** `standard` or `fast`. */
  readonly speed?: string | null;
  /** The whole bill per sampling iteration, each with its own model. */
  readonly iterations?: readonly AnthropicUsageIteration[] | null;
};

export type AnthropicUsageIteration = {
  readonly type: 'message' | 'compaction' | 'advisor_message' | 'fallback_message' | (string & {});
  readonly model?: string | null;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation?: AnthropicUsage['cache_creation'];
};
