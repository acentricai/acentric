// What a deploy says of the code it sends, and what the code says of itself.
//
// The manifest is written by whatever built the code, and is all the engine believes without
// running anything: which protocol the code speaks, and which version of the framework built
// it. The definition is the code's own account of the agent it defines. The engine gets it by
// asking the code, never from the deploy, so it is true of the code that runs.
//
// The definition has what the first milestone runs: instructions, tools, inputs and a
// configuration. What an agent declares for machines, MCP servers, subagents and schedules is
// added with each of them.

import { z } from 'zod';

import { providerFieldsSchema } from './content.ts';
import { jsonObjectSchema } from './json.ts';
import { providerIdSchema } from './messages.ts';

/** What a deploy says of its code. */
export const bundleManifestSchema = z
  .strictObject({
    /** The bundle protocol the code was built for (see `versions.ts`). */
    protocol: z.number().int().positive(),
    /** The version of `@acentric/agent` the code was built with. */
    sdk: z.string().min(1).max(64),
  })
  .meta({ id: 'BundleManifest' });
export type BundleManifest = z.infer<typeof bundleManifestSchema>;

/** The type of an input, as its agent names it: lowercase letters, digits and `_`. */
export const inputTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,62}$/,
    'An input type is lowercase letters, digits and _, starting with a letter',
  )
  .meta({ description: 'The type of an input, as its agent names it.', examples: ['message'] });
export type InputType = z.infer<typeof inputTypeSchema>;

/** A tool of the agent's own, as the model is told of it. */
export const toolDeclarationSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** The JSON Schema of its arguments. */
  parameters: jsonObjectSchema,
  /** Whether a call a crash cut off is safe to make again. */
  retrySafe: z.boolean(),
});
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

/** Something that can be sent to an actor of the agent. */
export const inputDeclarationSchema = z.object({
  type: inputTypeSchema,
  /** The JSON Schema of its payload. Null when its schema cannot say one. */
  schema: jsonObjectSchema.nullable(),
});
export type InputDeclaration = z.infer<typeof inputDeclarationSchema>;

/** An agent's definition, as far as it is data: what its code said when the engine asked. */
export const agentDefinitionSchema = z
  .object({
    provider: providerIdSchema,
    /** What the model is told, besides what the engine tells it. */
    instructions: z.string(),
    /**
     * The configuration an actor is created with: the JSON Schema of it, or null when its
     * schema cannot say one. Null for an agent whose actors take none.
     */
    configuration: z.object({ schema: jsonObjectSchema.nullable() }).nullable(),
    tools: z.array(toolDeclarationSchema),
    inputs: z.array(inputDeclarationSchema),
    /** What the agent asks of its provider that only that provider has, for the provider to read. */
    providerOptions: providerFieldsSchema.optional(),
  })
  .meta({ id: 'AgentDefinition' });
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
