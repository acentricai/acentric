// What a deploy says of the code it sends, and what the code says of itself.
//
// The manifest is written by whatever built the code, and is all the engine believes without
// running anything: which protocol the code speaks, and which version of the framework built
// it. The definition is the code's own account of the agent it defines. The engine gets it by
// asking the code, never from the deploy, so it is true of the code that runs.
//
// The definition has instructions, tools, inputs, a configuration, and the agents its actors
// can spawn. What an agent declares for MCP servers is added with them.

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

/** The name of a secret: letters, digits and `_`, not starting with a digit. */
export const secretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'A secret is named with letters, digits and _')
  .meta({ description: 'The name of a secret.', examples: ['ORDERS_API_KEY'] });
export type SecretName = z.infer<typeof secretNameSchema>;

/** The type of an input, as its agent names it: letters, digits, `_`, `.` and `-`, 64 at most. */
export const inputTypeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'An input type is 1 to 64 letters, digits, _, . or -')
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
  /**
   * True for a tool of the model's scripts: the model is not offered it, and a script it
   * writes calls it (see `code`).
   */
  codemode: z.boolean().optional(),
});
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

/** Something that can be sent to an actor of the agent. */
export const inputDeclarationSchema = z.object({
  type: inputTypeSchema,
  /** The JSON Schema of its payload. Null when its schema cannot say one. */
  schema: jsonObjectSchema.nullable(),
});
export type InputDeclaration = z.infer<typeof inputDeclarationSchema>;

/** An agent whose actors an actor of this one can spawn, as the model is told of it. */
export const subagentDeclarationSchema = z.object({
  /** The agent it is one of, by its name. */
  agent: z.string().min(1),
  /** What it is for, for the model that decides whether to spawn one. */
  description: z.string().min(1),
  /** Whether the agent's code says what one is created with: it has a `create`. */
  creates: z.boolean(),
  /** The JSON Schema of what the model gives when it spawns one, for one that takes any. */
  schema: jsonObjectSchema.optional(),
});
export type SubagentDeclaration = z.infer<typeof subagentDeclarationSchema>;

/** An MCP server whose tools the model's scripts can call, as far as it is data. */
export const mcpServerDeclarationSchema = z.object({
  /** How the agent names it: letters, digits, `_` and `-`, 64 at most. */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** Its MCP endpoint: an http or https URL. */
  url: z.url(),
  /** What it is for, as the agent says it: the model is not told its tools ahead. */
  description: z.string().min(1).optional(),
});
export type McpServerDeclaration = z.infer<typeof mcpServerDeclarationSchema>;

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
    /**
     * Its own numbers for when a conversation is compacted, by model: how large it may grow,
     * and how much of its end is kept as it is, in tokens. The engine has numbers for the rest.
     */
    compactionSettings: z
      .record(
        z.string().min(1),
        z.strictObject({
          threshold: z.number().int().nonnegative().optional(),
          reserve: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
    /**
     * The MCP servers whose tools its model's scripts can call. The headers a server is sent
     * are not here: the agent's code makes them when the engine asks.
     */
    mcps: z.array(mcpServerDeclarationSchema).optional(),
    /** The agents its actors can spawn actors of. */
    subagents: z.array(subagentDeclarationSchema).optional(),
    /** The secrets its code reads, by name, so that one that is not set can be told of. */
    secrets: z.array(secretNameSchema).optional(),
    /**
     * What it uses that an engine may not have, by name, such as `machine` or `schedule`. An
     * engine that lacks one refuses the deploy, and says which.
     */
    features: z.array(z.string().min(1)).optional(),
  })
  .meta({ id: 'AgentDefinition' });
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
