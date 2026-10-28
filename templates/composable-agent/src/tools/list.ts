// The tools the agent offers the model. An agent adds its own here, each
// with its handler in handlers.ts. Keep their order stable: what the model
// sees first should change least, for prompt caching.

import type { FunctionTool } from '@acentric/llm';

import type { AnyTool, ToolKind, ToolKindsOf } from './define.js';
import { toolKind } from './define.js';

export const TOOLS = [] as const satisfies readonly AnyTool[];

/** The tools' effect kinds: one per tool, with its args and result. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- empty until the agent has tools
export type ToolKinds = ToolKindsOf<typeof TOOLS>;

/** The tools' effect kinds' names, for the agent's list of kinds. */
export const TOOL_KINDS: (keyof ToolKinds)[] = kindsOf(TOOLS);

function kindsOf<T extends readonly AnyTool[]>(tools: T): ToolKind<T[number]['name']>[] {
  return tools.map((tool) => toolKind(tool.name));
}

/** The tool named `name`, if the agent has it. */
export function findTool(name: string): AnyTool | undefined {
  return TOOLS.find((tool: AnyTool) => tool.name === name);
}

/** What the model is told about the tools named in `names`, in the list's order. */
export function toolDefinitions(names: readonly string[]): FunctionTool[] {
  return TOOLS.filter((tool: AnyTool) => names.includes(tool.name)).map((tool: AnyTool) => ({
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
