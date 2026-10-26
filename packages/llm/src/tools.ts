// Tools the caller runs. A provider's hosted tools (web search, code
// execution, ...) are its own definitions, passed in the request's options.

import type { JsonObject } from '@acentric/types';

import type { ProviderFields } from './fields.js';

/** A JSON Schema object. */
export type JsonSchema = JsonObject;

type ToolBase = {
  readonly name: string;
  readonly description: string;
  /** Merged into the provider's tool definition, such as Anthropic's `cache_control`. */
  readonly providerOptions?: ProviderFields;
};

/** A tool called with JSON arguments matching `parameters`. */
export type FunctionTool = ToolBase & {
  readonly type: 'function';
  readonly parameters: JsonSchema;
  /** Asks the provider to hold the arguments to the schema, where it can. */
  readonly strict?: boolean;
};

/** A tool called with free-form text, optionally held to a grammar. Not every provider has them. */
export type CustomTool = ToolBase & {
  readonly type: 'custom';
  readonly format?: CustomToolFormat;
};

export type CustomToolFormat =
  | { readonly type: 'text' }
  | { readonly type: 'grammar'; readonly syntax: 'lark' | 'regex'; readonly definition: string };

export type ToolDefinition = FunctionTool | CustomTool;

export type ToolType = ToolDefinition['type'];
