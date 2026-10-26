// The Responses format: OpenAI's Responses API and the Open Responses
// specification other providers implement, here Fireworks. These are the
// shapes every Responses provider shares; each provider adds its own items in
// providers/.
//
// Items are typed for what the client and the readers interpret. Providers add
// fields and item types often, and those pass through as they are.

import type { Json } from '@acentric/types';

/** An explicit prompt-cache breakpoint on a content part. */
export type ResponsesCacheBreakpoint = { readonly mode: 'explicit' };

export type ResponsesInputText = {
  readonly type: 'input_text';
  readonly text: string;
  readonly prompt_cache_breakpoint?: ResponsesCacheBreakpoint;
};

export type ResponsesInputImage = {
  readonly type: 'input_image';
  /** A URL or a `data:` URL. */
  readonly image_url?: string;
  readonly file_id?: string;
  readonly detail?: 'auto' | 'low' | 'high' | 'original';
  readonly prompt_cache_breakpoint?: ResponsesCacheBreakpoint;
};

export type ResponsesInputFile = {
  readonly type: 'input_file';
  readonly file_id?: string;
  readonly file_url?: string;
  /** The file's bytes, as a `data:` URL. */
  readonly file_data?: string;
  readonly filename?: string;
  readonly detail?: 'auto' | 'low' | 'high';
  readonly prompt_cache_breakpoint?: ResponsesCacheBreakpoint;
};

export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage | ResponsesInputFile;

/** A user, system or developer message in the input. */
export type ResponsesInputMessage = {
  readonly type: 'message';
  readonly role: 'user' | 'system' | 'developer';
  readonly content: readonly ResponsesInputContent[];
};

export type ResponsesAnnotation =
  | {
      readonly type: 'url_citation';
      readonly url: string;
      readonly title: string;
      readonly start_index: number;
      readonly end_index: number;
    }
  | {
      readonly type: 'file_citation';
      readonly file_id: string;
      readonly filename: string;
      readonly index: number;
    }
  | {
      readonly type: 'container_file_citation';
      readonly container_id: string;
      readonly file_id: string;
      readonly filename: string;
      readonly start_index: number;
      readonly end_index: number;
    }
  | { readonly type: 'file_path'; readonly file_id: string; readonly index: number };

export type ResponsesOutputText = {
  readonly type: 'output_text';
  readonly text: string;
  readonly annotations: readonly ResponsesAnnotation[];
  readonly logprobs?: readonly Json[];
};

export type ResponsesRefusal = {
  readonly type: 'refusal';
  readonly refusal: string;
};

/** An assistant message in the output. */
export type ResponsesOutputMessage = {
  readonly type: 'message';
  readonly id: string;
  readonly role: 'assistant';
  readonly status: 'in_progress' | 'completed' | 'incomplete';
  /** `commentary` is a progress update, not the answer. Keep it when sending back. */
  readonly phase?: 'commentary' | 'final_answer' | null;
  readonly content: readonly (ResponsesOutputText | ResponsesRefusal)[];
};

export type ResponsesReasoning = {
  readonly type: 'reasoning';
  readonly id: string;
  readonly summary: readonly { readonly type: 'summary_text'; readonly text: string }[];
  readonly content?: readonly { readonly type: 'reasoning_text'; readonly text: string }[];
  /** Opaque: send it back unchanged. */
  readonly encrypted_content?: string | null;
  readonly status?: 'in_progress' | 'completed' | 'incomplete';
};

/** Who made a call, such as `{ type: "program", caller_id }` for programmatic tool calling. */
export type ResponsesCaller = { readonly type: string; readonly [key: string]: Json };

export type ResponsesFunctionCall = {
  readonly type: 'function_call';
  readonly id?: string;
  /** The ID a result answers; `id` is only the item's. */
  readonly call_id: string;
  readonly name: string;
  /** A JSON string, as the model wrote it. */
  readonly arguments: string;
  readonly namespace?: string;
  readonly caller?: ResponsesCaller;
  readonly async?: boolean;
  readonly status?: 'in_progress' | 'completed' | 'incomplete';
};

export type ResponsesCustomToolCall = {
  readonly type: 'custom_tool_call';
  readonly id?: string;
  readonly call_id: string;
  readonly name: string;
  readonly input: string;
  readonly namespace?: string;
  readonly caller?: ResponsesCaller;
  readonly async?: boolean;
};

export type ResponsesFunctionCallOutput = {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string | readonly ResponsesInputContent[];
  readonly id?: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly caller?: ResponsesCaller;
  readonly status?: 'in_progress' | 'completed' | 'incomplete';
};

export type ResponsesCustomToolCallOutput = {
  readonly type: 'custom_tool_call_output';
  readonly call_id: string;
  readonly output: string | readonly ResponsesInputContent[];
  readonly id?: string;
  readonly caller?: ResponsesCaller;
};

/** Earlier context, compacted. Opaque: send it back unchanged. */
export type ResponsesCompaction = {
  readonly type: 'compaction';
  readonly id?: string;
  readonly encrypted_content: string;
};

/** An item the provider stored, by ID. */
export type ResponsesItemReference = {
  readonly type: 'item_reference';
  readonly id: string;
};

/** Output items every Responses provider shares. */
export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesReasoning
  | ResponsesFunctionCall
  | ResponsesCustomToolCall
  | ResponsesCompaction;

/** Input items every Responses provider shares, besides output items sent back. */
export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallOutput
  | ResponsesCustomToolCallOutput
  | ResponsesItemReference
  | ResponsesOutputItem;

/**
 * An item a provider adds to the format, typed loosely: only the fields the
 * readers use are named, and the rest pass through.
 */
export type ResponsesItem<T extends string, Fields = unknown> = {
  readonly type: T;
  readonly id?: string;
  readonly [key: string]: Json;
} & Fields;

/** Token usage as the format reports it. */
export type ResponsesUsage = {
  /** Every input token, cached or not. */
  readonly input_tokens: number;
  readonly input_tokens_details?: {
    readonly cached_tokens?: number;
    readonly cache_write_tokens?: number;
  } | null;
  /** Output tokens, reasoning included. */
  readonly output_tokens: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number } | null;
  readonly total_tokens?: number;
};

export type ResponsesStatus =
  'completed' | 'incomplete' | 'failed' | 'cancelled' | 'queued' | 'in_progress';
