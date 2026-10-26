// OpenAI's Responses API: its credentials, request options, items beyond the
// shared Responses format, and the response fields kept in `native`.

import type { JsonObject } from '@acentric/types';

import type {
  ResponsesCaller,
  ResponsesInputItem,
  ResponsesItem,
  ResponsesOutputItem,
  ResponsesStatus,
} from '../formats/responses.js';

export type OpenAiCredentials = {
  readonly apiKey: string;
  /** Sent as `OpenAI-Organization`. */
  readonly organization?: string;
  /** Sent as `OpenAI-Project`. */
  readonly project?: string;
};

type CallStatus = { readonly status?: string };
type Called = { readonly call_id: string; readonly caller?: ResponsesCaller };

// ---- Hosted tools: OpenAI runs them, and their results are in the same output.

export type OpenAiWebSearchCall = ResponsesItem<'web_search_call', CallStatus>;
export type OpenAiFileSearchCall = ResponsesItem<'file_search_call', CallStatus>;
export type OpenAiCodeInterpreterCall = ResponsesItem<'code_interpreter_call', CallStatus>;
export type OpenAiImageGenerationCall = ResponsesItem<
  'image_generation_call',
  CallStatus & { readonly result?: string | null }
>;
export type OpenAiMcpCall = ResponsesItem<
  'mcp_call',
  CallStatus & { readonly server_label: string; readonly name: string }
>;
export type OpenAiMcpListTools = ResponsesItem<'mcp_list_tools', { readonly server_label: string }>;

// ---- Provider-defined tools the caller runs, answered with `native` items.

export type OpenAiComputerCall = ResponsesItem<'computer_call', Called & CallStatus>;
export type OpenAiShellCall = ResponsesItem<'shell_call', Called & CallStatus>;
export type OpenAiApplyPatchCall = ResponsesItem<'apply_patch_call', Called & CallStatus>;
export type OpenAiLocalShellCall = ResponsesItem<'local_shell_call', Called & CallStatus>;
export type OpenAiToolSearchCall = ResponsesItem<
  'tool_search_call',
  CallStatus & { readonly call_id?: string | null; readonly execution?: 'server' | 'client' }
>;
/** A hosted MCP tool waiting for the caller's approval. */
export type OpenAiMcpApprovalRequest = ResponsesItem<
  'mcp_approval_request',
  {
    readonly id: string;
    readonly server_label: string;
    readonly name: string;
    readonly arguments: string;
  }
>;

// ---- The results of those calls, and other items the caller writes.

export type OpenAiComputerCallOutput = ResponsesItem<'computer_call_output', Called>;
export type OpenAiShellCallOutput = ResponsesItem<'shell_call_output', Called>;
export type OpenAiApplyPatchCallOutput = ResponsesItem<
  'apply_patch_call_output',
  Called & { readonly status: 'completed' | 'failed'; readonly output?: string | null }
>;
export type OpenAiLocalShellCallOutput = ResponsesItem<
  'local_shell_call_output',
  { readonly output: string }
>;
export type OpenAiToolSearchOutput = ResponsesItem<
  'tool_search_output',
  { readonly call_id?: string | null; readonly tools: readonly OpenAiTool[] }
>;
export type OpenAiMcpApprovalResponse = ResponsesItem<
  'mcp_approval_response',
  { readonly approval_request_id: string; readonly approve: boolean; readonly reason?: string }
>;
/** Programmatic tool calling: a program the model wrote, and its result. */
export type OpenAiProgram = ResponsesItem<
  'program',
  { readonly call_id: string; readonly fingerprint: string }
>;
export type OpenAiProgramOutput = ResponsesItem<'program_output', { readonly call_id: string }>;
/** Tools added in the middle of the conversation, at this point. */
export type OpenAiAdditionalTools = ResponsesItem<
  'additional_tools',
  { readonly role: string; readonly tools: readonly OpenAiTool[] }
>;
/** Changes the reasoning effort without breaking the prompt cache. */
export type OpenAiConfigurationUpdate = ResponsesItem<
  'configuration_update',
  { readonly reasoning?: { readonly effort?: OpenAiReasoningEffort } }
>;
/** Compacts the context so far. Must be the last input item. */
export type OpenAiCompactionTrigger = ResponsesItem<'compaction_trigger'>;

export type OpenAiOutputItem =
  | ResponsesOutputItem
  | OpenAiWebSearchCall
  | OpenAiFileSearchCall
  | OpenAiCodeInterpreterCall
  | OpenAiImageGenerationCall
  | OpenAiMcpCall
  | OpenAiMcpListTools
  | OpenAiMcpApprovalRequest
  | OpenAiMcpApprovalResponse
  | OpenAiComputerCall
  | OpenAiShellCall
  | OpenAiShellCallOutput
  | OpenAiApplyPatchCall
  | OpenAiApplyPatchCallOutput
  | OpenAiLocalShellCall
  | OpenAiToolSearchCall
  | OpenAiToolSearchOutput
  | OpenAiProgram
  | OpenAiProgramOutput
  | OpenAiAdditionalTools;

/** An item a `native` message may carry. */
export type OpenAiInputItem =
  | ResponsesInputItem
  | OpenAiOutputItem
  | OpenAiComputerCallOutput
  | OpenAiLocalShellCallOutput
  | OpenAiConfigurationUpdate
  | OpenAiCompactionTrigger;

// ---- Request options: the Responses request body, less `model`, `input` and
// `instructions`, which the request owns.

export type OpenAiReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A native tool definition: hosted tools, namespaces, tool search, MCP, shell, computer. */
export type OpenAiTool = JsonObject & {
  readonly type:
    | 'function'
    | 'custom'
    | 'namespace'
    | 'tool_search'
    | 'programmatic_tool_calling'
    | 'web_search'
    | 'file_search'
    | 'code_interpreter'
    | 'image_generation'
    | 'mcp'
    | 'shell'
    | 'apply_patch'
    | 'computer'
    | (string & {});
};

export type OpenAiInclude =
  | 'reasoning.encrypted_content'
  | 'message.output_text.logprobs'
  | 'message.input_image.image_url'
  | 'web_search_call.action.sources'
  | 'web_search_call.results'
  | 'file_search_call.results'
  | 'code_interpreter_call.outputs'
  | 'computer_call_output.output.image_url'
  | (string & {});

export type OpenAiServiceTier =
  'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | 'ultrafast';

export type OpenAiTextFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly name: string;
      readonly schema: JsonObject;
      readonly description?: string;
      readonly strict?: boolean | null;
    };

export type OpenAiOptions = {
  /** Hosted and other native tools, sent after the request's own. */
  readonly tools?: readonly OpenAiTool[];
  readonly tool_choice?: 'none' | 'auto' | 'required' | (JsonObject & { readonly type: string });
  readonly parallel_tool_calls?: boolean | null;
  /** Caps calls to built-in tools. */
  readonly max_tool_calls?: number | null;
  /** Covers visible output and reasoning. */
  readonly max_output_tokens?: number | null;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly top_logprobs?: number | null;
  readonly reasoning?: {
    readonly effort?: OpenAiReasoningEffort | null;
    readonly summary?: 'auto' | 'concise' | 'detailed' | null;
    readonly context?: 'auto' | 'current_turn' | 'all_turns' | null;
    readonly mode?: 'standard' | 'pro' | (string & {}) | null;
  } | null;
  readonly text?: {
    readonly format?: OpenAiTextFormat;
    readonly verbosity?: 'low' | 'medium' | 'high' | null;
  } | null;
  /** Defaults to `true` at OpenAI: the response is kept for at least 30 days. */
  readonly store?: boolean | null;
  readonly include?: readonly OpenAiInclude[] | null;
  /**
   * Continues from a stored response, so only the new messages are sent.
   * Instructions and tools are not inherited.
   */
  readonly previous_response_id?: string | null;
  /** A conversation OpenAI keeps. Excludes `previous_response_id`. */
  readonly conversation?: string | { readonly id: string } | null;
  /** Compaction by OpenAI inside the request. */
  readonly context_management?:
    | readonly {
        readonly type: 'compaction' | (string & {});
        readonly compact_threshold?: number;
      }[]
    | null;
  readonly metadata?: { readonly [key: string]: string } | null;
  readonly safety_identifier?: string | null;
  readonly prompt_cache_key?: string | null;
  readonly prompt_cache_options?: {
    readonly ttl?: '30m' | (string & {});
    readonly mode?: 'implicit' | 'explicit';
    readonly prewarm?: boolean;
    readonly comparison_response_id?: string;
  } | null;
  readonly service_tier?: OpenAiServiceTier | null;
  readonly moderation?: JsonObject | null;
  readonly access_programs?: JsonObject | null;
  /** The client returns one finished response, so `true` is refused. */
  readonly stream?: false | null;
  /** The client returns one finished response, so `true` is refused. */
  readonly background?: false | null;
};

/**
 * The response's own fields, kept in `native`: what it says that the request
 * did not. Echoes of the request and fields already in the response are left out.
 */
export type OpenAiNativeResponse = JsonObject & {
  readonly status: ResponsesStatus;
  readonly created_at?: number;
  readonly completed_at?: number | null;
  readonly incomplete_details?: { readonly reason?: string } | null;
  /** The tier actually used, which may differ from the one asked for. */
  readonly service_tier?: OpenAiServiceTier | null;
  /** The reasoning settings in effect. */
  readonly reasoning?: JsonObject | null;
};

/** Model IDs the types know. Any other works too. */
export type OpenAiModelId =
  | 'gpt-6-astra'
  | 'gpt-6.1-sol'
  | 'gpt-6-sol'
  | 'gpt-6-luna'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  | 'gpt-5.5'
  | 'gpt-5.4'
  | 'gpt-5.4-mini'
  | 'gpt-4.1';

export type OpenAiSpec = {
  readonly api: 'openai-responses';
  readonly credentials: OpenAiCredentials;
  readonly options: OpenAiOptions;
  readonly inputItem: OpenAiInputItem;
  readonly outputItem: OpenAiOutputItem;
  readonly response: OpenAiNativeResponse;
  readonly modelId: OpenAiModelId;
};
