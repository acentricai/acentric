// What the rest of the agent reads from the tool list: the tools by name,
// their effect kinds, and what the model is told about them.

import type { FunctionTool } from '@acentric/llm';
import type { Json } from '@acentric/types';

import type { AnyTool, ToolEffectArgs, ToolKind } from './define.js';
import { toolKind } from './define.js';
import { TOOLS } from './list.js';

/**
 * The tools' effect kinds. One kind per tool, `tool:<name>`; the agent
 * types them alike, and a tool's handler is registered under its own name
 * by toolHandlers, so one cannot end up under another's kind.
 */
export type ToolKinds = Record<ToolKind<string>, { args: ToolEffectArgs; result: Json }>;

/** The tools' effect kinds' names, for the agent's list of kinds. */
export const TOOL_KINDS = TOOLS.map((tool) => toolKind(tool.name));

/** The tool named `name`, if the agent has it. */
export function findTool(name: string): AnyTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** The names of the tools offered to the model, in the list's order. */
export function toolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

/** What the model is told about the tools named in `names`, in the list's order. */
export function toolDefinitions(names: readonly string[]): FunctionTool[] {
  return TOOLS.filter((tool) => names.includes(tool.name)).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: schemaJson(tool),
  }));
}

/** A tool's parameters as a plain JSON Schema object. */
function schemaJson(tool: AnyTool): FunctionTool['parameters'] {
  const schema: unknown = JSON.parse(JSON.stringify(tool.parameters));
  if (!isJsonObject(schema)) {
    throw new TypeError(`the parameters of ${tool.name} are not a JSON object`);
  }
  return schema;
}

// What JSON.parse returns is JSON, so an object from it is a JSON object.
function isJsonObject(value: unknown): value is FunctionTool['parameters'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
