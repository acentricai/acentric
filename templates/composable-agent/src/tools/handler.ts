// A tool's handler: the I/O half, imported by handlers.ts and never by the
// agent. toolHandler reads the call's arguments from the reply in the log,
// checks them as step did, and gives them to the tool's own function typed
// by its parameters, with what `prepare` passed on. toolHandlers puts each
// under its own tool's kind.

import { toolCalls } from '@acentric/llm';
import type { HandlerContext, HandlerDef, Json } from '@acentric/types';
import type { Static, TSchema } from 'typebox';

import { logOf } from '../core/log.js';
import type { ConversationEntries } from '../core/log.js';
import { parseArguments } from './arguments.js';
import { toolKind } from './define.js';
import type { ToolDef, ToolEffectArgs, ToolKind } from './define.js';

const conversation = logOf<ConversationEntries>();

/** A tool's handler, with the kind it serves. */
export type ToolHandler<N extends string = string, E extends Json = Json, R extends Json = Json> = {
  readonly kind: ToolKind<N>;
  readonly handler: HandlerDef<ToolEffectArgs<E>, R>;
};

/** The handler of `tool`, from a function that takes its checked arguments. */
export function toolHandler<N extends string, S extends TSchema, E extends Json, R extends Json>(
  tool: ToolDef<N, S, E, R>,
  run: (args: Static<S>, extra: E, ctx: HandlerContext<ToolEffectArgs<E>>) => Promise<R>,
): ToolHandler<N, E, R> {
  return {
    kind: toolKind(tool.name),
    handler: {
      mode: tool.mode,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.maxAttempts === undefined ? {} : { maxAttempts: tool.maxAttempts }),
      run: async (ctx) => run(await readArguments(tool, ctx), ctx.args.extra, ctx),
    },
  };
}

/** The tools' handlers, each under its own tool's kind, for handlers.ts. */
export function toolHandlers(
  ...tools: readonly ToolHandler[]
): Record<ToolKind<string>, HandlerDef<ToolEffectArgs>> {
  return Object.fromEntries(tools.map(({ kind, handler }) => [kind, handler]));
}

/** The arguments of the call the effect runs, read from its reply. Throws if they cannot be read. */
async function readArguments<S extends TSchema, E extends Json>(
  tool: ToolDef<string, S, E>,
  ctx: HandlerContext<ToolEffectArgs<E>>,
): Promise<Static<S>> {
  const { replySeq, callId } = ctx.args;
  const page = await ctx.log.list({ after: replySeq - 1, before: replySeq + 1, limit: 1 });
  const entry = page.entries[0];
  if (entry === undefined || !conversation.isKind(entry, 'assistant')) {
    throw new Error(`no reply at log entry ${replySeq}`);
  }
  const call = toolCalls(entry.body.message).find((c) => c.toolCallId === callId);
  if (call === undefined) throw new Error(`reply ${replySeq} has no call ${callId}`);
  const read = parseArguments(tool.parameters, call);
  if ('error' in read) throw new Error(read.error);
  return read.args;
}
