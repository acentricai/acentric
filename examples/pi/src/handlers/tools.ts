// The four tool handlers. Each wraps pi's own tool, so truncation, fuzzy
// edit matching, error texts and image handling are pi's exactly.
//
// A handler reads its tool call from the log, prepares the arguments with
// the same function step used to accept them, and runs pi's tool. Like pi,
// it reports a tool that throws as an error result rather than failing, so
// what an aborted command printed is kept.

import type { HandlerContext, HandlerDef, JsonObject } from '@acentric/types';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { TextBlock, ToolResult } from '../content.js';
import { isJson, isObject } from '../guards.js';
import type { ToolCallRef } from '../kinds.js';
import { findTool, prepareToolArguments } from '../tools.js';
import type { ToolName } from '../tools.js';
import { readToolCall } from './log.js';

/** What a pi tool returns, as far as the handler needs it. */
type PiToolResult = {
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError?: boolean;
};

/** The parts of a pi tool the handler uses. */
type PiTool<T extends TSchema> = {
  parameters: T;
  execute: (toolCallId: string, params: Static<T>, signal?: AbortSignal) => Promise<PiToolResult>;
};

export function toolHandler(name: ToolName): HandlerDef<ToolCallRef, ToolResult> {
  const definition = findTool(name);
  if (definition === null) throw new Error(`unknown tool ${name}`);
  return {
    mode: definition.mode,
    async run(ctx) {
      const { seq, toolCallId, cwd } = ctx.args;
      const prepared = prepareToolArguments(await readToolCall(ctx.log, seq, toolCallId));
      if ('error' in prepared) return errorResult(prepared.error);
      try {
        switch (name) {
          case 'read':
            return await execute(createReadTool(cwd), prepared.args, ctx);
          case 'bash':
            return await execute(createBashTool(cwd), prepared.args, ctx);
          case 'edit':
            return await execute(createEditTool(cwd), prepared.args, ctx);
          case 'write':
            return await execute(createWriteTool(cwd), prepared.args, ctx);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

async function execute<T extends TSchema>(
  tool: PiTool<T>,
  args: JsonObject,
  ctx: HandlerContext<ToolCallRef>,
): Promise<ToolResult> {
  if (!Value.Check(tool.parameters, args)) {
    return errorResult('The arguments do not match the tool schema');
  }
  const result = await tool.execute(ctx.args.toolCallId, args, ctx.signal);
  const content = result.content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image' as const, data: block.data, mimeType: block.mimeType },
  );
  const details = toJsonObject(result.details);
  return { content, isError: result.isError === true, ...(details === null ? {} : { details }) };
}

/** Details as plain Json, dropping undefined values, or null if they are not an object. */
function toJsonObject(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isJson(parsed) && isObject(parsed) ? parsed : null;
}

function errorResult(text: string): ToolResult {
  const block: TextBlock = { type: 'text', text };
  return { content: [block], isError: true };
}
