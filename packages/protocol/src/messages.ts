// A conversation's messages, as they are kept and as the API gives them.
//
// A model's answer is its provider's own output, kept as it is and sent back unchanged:
// reasoning, signatures and all. So here an answer's content is JSON that this package does
// not read. The provider that wrote it knows its shape, and reads it. That is what lets a new
// provider be added without a change here.

import { z } from 'zod';

import {
  contentPartSchema,
  imagePartSchema,
  metadataSchema,
  providerFieldsSchema,
  textPartSchema,
} from './content.ts';
import { jsonObjectSchema, jsonSchema } from './json.ts';
import { timestampSchema } from './primitives.ts';

/** A provider's ID, such as `anthropic`. Providers are not listed here: each is a module of its own. */
export const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'A provider ID is lowercase letters, digits, - and _')
  .meta({ description: "A model provider's ID.", examples: ['anthropic'] });
export type ProviderId = z.infer<typeof providerIdSchema>;

/** A model's ID, as its provider names it. */
export const modelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .meta({ description: "A model's ID, as its provider names it." });
export type ModelId = z.infer<typeof modelIdSchema>;

/** How hard a model thinks. A provider turns it into what it and the model take. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const reasoningSchema = z.enum(REASONING_LEVELS);
export type Reasoning = z.infer<typeof reasoningSchema>;

// Tools

const toolBase = {
  name: z.string().min(1),
  /** What the tool does, for the model. */
  description: z.string(),
  /** Merged into the provider's tool definition. */
  providerOptions: providerFieldsSchema.optional(),
};

/** A JSON Schema, as an object. */
export const jsonSchemaObjectSchema = jsonObjectSchema;

/** A tool called with JSON arguments that match `parameters`. */
export const functionToolSchema = z.object({
  type: z.literal('function'),
  ...toolBase,
  parameters: jsonSchemaObjectSchema,
  /** Asks the provider to hold the arguments to the schema, where it can. */
  strict: z.boolean().optional(),
});
export type FunctionTool = z.infer<typeof functionToolSchema>;

/** A tool called with free text, which may be held to a grammar. Not every provider has them. */
export const customToolSchema = z.object({
  type: z.literal('custom'),
  ...toolBase,
  format: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('text') }),
      z.object({
        type: z.literal('grammar'),
        syntax: z.enum(['lark', 'regex']),
        definition: z.string(),
      }),
    ])
    .optional(),
});
export type CustomTool = z.infer<typeof customToolSchema>;

export const toolDefinitionSchema = z.discriminatedUnion('type', [
  functionToolSchema,
  customToolSchema,
]);
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolTypeSchema = z.enum(['function', 'custom']);
export type ToolType = z.infer<typeof toolTypeSchema>;

// Messages

const messageBase = {
  /** For a model's answer, the provider's ID of its response. Otherwise the application's. */
  id: z.string().optional(),
  timestamp: timestampSchema.optional(),
  /** The application's own attributes. Never sent to a provider. */
  metadata: metadataSchema.optional(),
};

export const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.array(contentPartSchema),
  ...messageBase,
});
export type UserMessage = z.infer<typeof userMessageSchema>;

/** An instruction in the middle of the conversation. A provider with no such messages refuses one. */
export const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.array(z.discriminatedUnion('type', [textPartSchema, imagePartSchema])),
  /** Merged into the provider's message, for fields of its own. */
  providerOptions: providerFieldsSchema.optional(),
  ...messageBase,
});
export type SystemMessage = z.infer<typeof systemMessageSchema>;

/**
 * A model's answer: its provider's output, as it is, for sending back. It is safe to send back
 * to the same provider, format and model.
 */
export const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  provider: providerIdSchema,
  /** The wire format the answer is in, such as `anthropic-messages`: the provider's to name. */
  api: z.string().min(1),
  /** The model the request asked for. */
  model: modelIdSchema,
  /** The provider's output items, unread here. */
  content: z.array(jsonObjectSchema),
  ...messageBase,
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

/** The result of a tool call. */
export const toolResultMessageSchema = z.object({
  role: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  /** The type of the tool that was called. `function` without it. */
  toolType: toolTypeSchema.optional(),
  content: z.array(contentPartSchema),
  /** The tool failed. It is sent only where the provider has a field for it, so `content` says what failed either way. */
  isError: z.boolean().optional(),
  /** Merged into the provider's result item, for fields it needs on results. */
  providerOptions: providerFieldsSchema.optional(),
  ...messageBase,
});
export type ToolResultMessage = z.infer<typeof toolResultMessageSchema>;

/** Input only one provider takes, sent as it is: a compaction item, an approval. */
export const nativeMessageSchema = z.object({
  role: z.literal('native'),
  provider: providerIdSchema,
  api: z.string().min(1),
  content: z.array(jsonObjectSchema),
  ...messageBase,
});
export type NativeMessage = z.infer<typeof nativeMessageSchema>;

/** The application's own entry in a conversation. Never sent to a provider. */
export const customMessageSchema = z.object({
  role: z.literal('custom'),
  /** Says how the application reads `data`. */
  tag: z.string().min(1),
  data: jsonSchema,
  ...messageBase,
});
export type CustomMessage = z.infer<typeof customMessageSchema>;

/** Any message of a conversation. */
export const messageSchema = z
  .discriminatedUnion('role', [
    userMessageSchema,
    systemMessageSchema,
    assistantMessageSchema,
    toolResultMessageSchema,
    nativeMessageSchema,
    customMessageSchema,
  ])
  .meta({ id: 'Message' });
export type Message = z.infer<typeof messageSchema>;

export type MessageRole = Message['role'];

// What a model call reports besides its message.

/** Why a model stopped. */
export const stopReasonSchema = z.enum([
  /** It ended as it would, a stop sequence included. */
  'stop',
  /** It was cut short by a limit on output tokens or length. */
  'length',
  /** It called tools for the caller to run. */
  'tool_use',
  /** The model declined. */
  'refusal',
  /** A provider's safety filter blocked or ended it. */
  'content_filter',
  /** The provider paused a turn that can go on, as during a long tool run of its own. */
  'pause_turn',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

const count = z.number().int().nonnegative().optional();
const dollars = z.number().nonnegative().optional();

/** US dollars. A part that is not known is left out. */
export const usageCostSchema = z.object({
  /** `reported`: what the provider says it charged. `estimated`: tokens at known prices. */
  source: z.enum(['reported', 'estimated']),
  input: dollars,
  output: dollars,
  cacheRead: dollars,
  cacheWrite: dollars,
  webSearch: dollars,
  total: z.number().nonnegative(),
});
export type UsageCost = z.infer<typeof usageCostSchema>;

/** Token counts. A count the provider does not report is left out: zero is a known zero. */
export const usageSchema = z
  .object({
    /** Every prompt token, cached or not. */
    totalInput: count,
    /** Prompt tokens neither read from nor written to a cache. */
    input: count,
    /** Output tokens, reasoning included where the provider counts it as output. */
    output: count,
    /** Reasoning tokens: part of `output` unless the provider bills them apart. */
    reasoning: count,
    cacheRead: count,
    /** Every token written to a cache, whatever its time to live. */
    cacheWrite: count,
    /** Searches the provider's own web search made, which it charges for apart from tokens. */
    webSearches: count,
    cost: usageCostSchema.optional(),
  })
  .meta({ id: 'Usage' });
export type Usage = z.infer<typeof usageSchema>;
