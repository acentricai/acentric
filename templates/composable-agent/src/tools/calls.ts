// What step does with a reply's tool calls: decide how each one goes ahead,
// which may run now, and what the model reads when each one is done. The
// loop applies what these return; they change nothing themselves.
//
// The tools' hooks get the tools part of the snapshot as `state`, and
// return it changed from the one they were given.

import type { ToolCall } from '@acentric/llm';
import type { Json, Outcome } from '@acentric/types';

import { parseArguments } from './arguments.js';
import type {
  AnyTool,
  Prepared,
  ToolContext,
  ToolFailure,
  ToolOutput,
  ToolReply,
} from './define.js';
import { defaultOutput, describeFailure } from './output.js';
import { findTool } from './registry.js';
import type { CallState, ToolsState } from './state.js';

/** A call answered at once, with what the model reads. */
export type Answer = { call: ToolCall; output: ToolOutput };

/**
 * How each of a reply's calls goes ahead, in the order the model made them:
 * answered at once (an unknown tool, bad arguments, or `prepare` answering),
 * or waiting to run, still without a key. Also the tools part as `prepare`
 * left it.
 */
export function startCalls(
  calls: readonly ToolCall[],
  ctx: ToolContext,
): { answers: Answer[]; waiting: Omit<CallState, 'key'>[]; state: ToolsState } {
  const answers: Answer[] = [];
  const waiting: Omit<CallState, 'key'>[] = [];
  let state = ctx.state;
  for (const call of calls) {
    const tool = findTool(call.toolName);
    if (tool === undefined) {
      answers.push({ call, output: error(`there is no tool named ${call.toolName}`) });
      continue;
    }
    const read = parseArguments(tool.parameters, call);
    if ('error' in read) {
      answers.push({ call, output: error(read.error) });
      continue;
    }
    const prepared: Prepared<Json> = tool.prepare?.(read.args, { ...ctx, state }) ?? { run: {} };
    state = prepared.state ?? state;
    if ('answer' in prepared) answers.push({ call, output: prepared.answer });
    else {
      waiting.push({
        callId: call.toolCallId,
        name: tool.name,
        extra: prepared.run,
        status: 'waiting',
      });
    }
  }
  return { answers, waiting, state };
}

/**
 * The calls with every waiting one that may run now marked running. Walking
 * them in order, a call waits while one before it is unfinished and either
 * is sequential, or one before it with the same resource key is
 * unfinished. Nothing starts once the turn is stopping.
 */
export function schedule(
  calls: readonly CallState[],
  replyCalls: readonly ToolCall[],
  stopping: boolean,
): CallState[] {
  const scheduled: CallState[] = [];
  for (const call of calls) {
    if (call.status !== 'waiting' || stopping) {
      scheduled.push(call);
      continue;
    }
    const key = resourceKey(call, replyCalls);
    const blocked = scheduled.some(
      (before) =>
        before.status !== 'done' &&
        (isSequential(call) ||
          isSequential(before) ||
          (key !== null && resourceKey(before, replyCalls) === key)),
    );
    scheduled.push(blocked ? call : { ...call, status: 'running' });
  }
  return scheduled;
}

/** What the model reads for a call whose effect reported, and the tools part as the tool left it. */
export function settleCall(
  call: CallState,
  replyCall: ToolCall,
  outcome: Outcome,
  ctx: ToolContext,
): { output: ToolOutput; state: ToolsState } {
  const tool = findTool(call.name);
  const read = tool === undefined ? null : parseArguments(tool.parameters, replyCall);
  // A tool removed, or its parameters changed, by an upgrade while its call ran.
  if (tool === undefined || read === null || 'error' in read) {
    return { output: describeFailure(call.name, failureOf(outcome)), state: ctx.state };
  }
  const settle = { ...ctx, args: read.args, extra: call.extra };
  const reply: ToolReply =
    'ok' in outcome
      ? (tool.result?.(outcome.ok, settle) ?? defaultOutput(outcome.ok))
      : (tool.unfinished?.(failureOf(outcome), settle) ??
        describeFailure(call.name, failureOf(outcome)));
  const { state, ...output } = reply;
  return { output, state: state ?? ctx.state };
}

/** What the model reads for a call that was never run. */
export function notRun(name: string, why: string): ToolOutput {
  return error(`${name} was not run: ${why}`);
}

function error(text: string): ToolOutput {
  return { content: text, isError: true };
}

function failureOf(outcome: Outcome): ToolFailure {
  return 'failed' in outcome ? outcome.failed : { code: 'interrupted', error: null };
}

function isSequential(call: CallState): boolean {
  return findTool(call.name)?.concurrency === 'sequential';
}

/** The call's resource key, if its tool gives calls one. */
function resourceKey(call: CallState, replyCalls: readonly ToolCall[]): string | null {
  const tool: AnyTool | undefined = findTool(call.name);
  const replyCall = replyCalls.find((c) => c.toolCallId === call.callId);
  if (tool?.resourceKey === undefined || replyCall === undefined) return null;
  const read = parseArguments(tool.parameters, replyCall);
  return 'error' in read ? null : tool.resourceKey(read.args);
}
