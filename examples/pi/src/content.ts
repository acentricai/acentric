// The model-facing data the pi agent stores and passes between step and
// handlers: content blocks, the assistant message an LLM call produces, and
// the result a tool produces. They mirror pi's own types, keeping the fields
// the agent needs, and are plain Json.

import type { JsonObject } from '@acentric/types';

export type TextBlock = {
  type: 'text';
  text: string;
  /** A provider's signature for the text, sent back with it. */
  textSignature?: string;
};

/** An image as base64 data. */
export type ImageBlock = {
  type: 'image';
  data: string;
  mimeType: string;
};

/** The model's reasoning. The signature lets a provider verify it when it is sent back. */
export type ThinkingBlock = {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

/** A tool the model asked to run. `id` ties it to its result. */
export type ToolCallBlock = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: JsonObject;
  /** Set when the model sent arguments that are not valid Json; `arguments` is then empty. */
  argumentsError?: string;
  /** A provider's signature for the reasoning behind the call, sent back with it. */
  thoughtSignature?: string;
};

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Which model to call. */
export type ModelRef = {
  provider: string;
  id: string;
};

/** Tokens used by one model call, and what they cost in USD. */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

/**
 * Why a model call ended.
 *   - stop: the model finished.
 *   - length: it hit the output token limit.
 *   - toolUse: it wants tools run.
 *   - error: the call failed; `errorMessage` says why.
 *   - aborted: it was stopped; the content is what had arrived so far.
 */
export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

/** What one model call produced. */
export type AssistantMessage = {
  content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
  /** The API, provider and model that answered, as the provider reports them. */
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
};

/** What one tool call produced. `isError` tells the model the call failed. */
export type ToolResult = {
  content: (TextBlock | ImageBlock)[];
  /** Extra data for callers and UIs, such as a diff. Not sent to the model. */
  details?: JsonObject;
  isError: boolean;
};
