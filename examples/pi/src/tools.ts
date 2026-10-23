// The four tools: how they are described to the model, and how step checks
// a tool call's arguments before running it. Descriptions, schemas and
// prompt text come from pi's coding agent.
//
// Checking is pure, so step does it and the handler that runs the tool does
// the same with `prepareToolArguments`, getting exactly the arguments step
// accepted.

import type { Json, JsonObject } from '@acentric/types';
import { Type } from 'typebox';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { ToolCallBlock } from './content.js';
import type { Mode } from '@acentric/types';
import { copyJson, isJson, isObject, parseJson } from './guards.js';

/** pi's truncation limits for tool output. */
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export type ToolName = 'read' | 'bash' | 'edit' | 'write';

export type ToolDef = {
  name: ToolName;
  description: string;
  parameters: TSchema;
  mode: Mode;
  /** One line about the tool in the system prompt. */
  snippet: string;
  /** Rules the tool adds to the system prompt. */
  guidelines: string[];
};

const editEntry = Type.Object({
  oldText: Type.String({
    description:
      'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
  }),
  newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
});

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'read',
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
      offset: Type.Optional(
        Type.Number({ description: 'Line number to start reading from (1-indexed)' }),
      ),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
    }),
    mode: 'reissue',
    snippet: 'Read file contents',
    guidelines: ['Use read to examine files instead of cat or sed.'],
  },
  {
    name: 'bash',
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(
        Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }),
      ),
    }),
    mode: 'once',
    snippet: 'Execute bash commands (ls, grep, find, etc.)',
    guidelines: [],
  },
  {
    name: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
      edits: Type.Array(editEntry, {
        description:
          'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
      }),
    }),
    mode: 'once',
    snippet:
      'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
    guidelines: [
      'Use edit for precise changes (edits[].oldText must match exactly)',
      'When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
      'Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
      'Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
    ],
  },
  {
    name: 'write',
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    mode: 'reissue',
    snippet: 'Create or overwrite files',
    guidelines: ['Use write only for new files or complete rewrites.'],
  },
];

export function findTool(name: string): ToolDef | null {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * The arguments a tool call runs with, after the same repairs pi makes, or
 * the error the model is told. Unknown tools are an error too.
 */
export function prepareToolArguments(
  call: ToolCallBlock,
): { args: JsonObject } | { error: string } {
  const tool = findTool(call.name);
  if (!tool) return { error: `Tool ${call.name} not found` };
  if (call.argumentsError !== undefined) {
    return { error: `Invalid arguments for tool "${call.name}": ${call.argumentsError}` };
  }
  const repaired = tool.name === 'edit' ? repairEditArguments(call.arguments) : call.arguments;
  // Convert turns values such as "5" into the schema's types, the way pi does.
  const converted: unknown = Value.Convert(tool.parameters, copyJson(repaired));
  if (isJson(converted) && isObject(converted) && Value.Check(tool.parameters, converted)) {
    return { args: converted };
  }
  const problems = [...Value.Errors(tool.parameters, converted)].map((problem) => {
    const where = problem.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'root';
    return `  - ${where}: ${problem.message}`;
  });
  return {
    error: `Validation failed for tool "${call.name}":\n${problems.join('\n')}\n\nReceived arguments:\n${JSON.stringify(call.arguments, null, 2)}`,
  };
}

/**
 * pi accepts a few shapes models get wrong for edit: `edits` sent as a Json
 * string or as a single object, and the older top-level oldText/newText.
 */
function repairEditArguments(input: JsonObject): JsonObject {
  const args: JsonObject = { ...input };
  const edits = args['edits'];
  if (typeof edits === 'string') {
    const parsed = parseJson(edits);
    if (Array.isArray(parsed)) args['edits'] = parsed;
    else if (isEditEntry(parsed)) args['edits'] = [parsed];
  } else if (isEditEntry(edits)) {
    args['edits'] = [edits];
  }
  const { oldText, newText, ...rest } = args;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return args;
  const listed = rest['edits'];
  return { ...rest, edits: [...(Array.isArray(listed) ? listed : []), { oldText, newText }] };
}

function isEditEntry(value: Json | undefined): value is JsonObject {
  return (
    isObject(value) && typeof value['oldText'] === 'string' && typeof value['newText'] === 'string'
  );
}

/**
 * The file an edit or write changes, so step can run edits to one file one
 * at a time; null for other tools. Relative paths resolve against `cwd`,
 * and a leading `@` is dropped, as pi does.
 */
export function changedPath(name: string, args: JsonObject, cwd: string): string | null {
  if (name !== 'edit' && name !== 'write') return null;
  const path = args['path'];
  return typeof path === 'string' ? resolvePath(cwd, path) : null;
}

function resolvePath(cwd: string, path: string): string {
  const bare = path.startsWith('@') ? path.slice(1) : path;
  const joined = bare.startsWith('/') || bare.startsWith('~') ? bare : `${cwd}/${bare}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return joined.startsWith('~') ? parts.join('/') : `/${parts.join('/')}`;
}

/** What is sent to the model for each tool. */
export function toolDeclarations(): { name: string; description: string; parameters: TSchema }[] {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
