// How a tool is defined: everything the loop needs to offer it to the
// model and run its calls, without knowing what it does.
//
// A tool has a pure half, defined here and imported by the agent, and a
// handler, defined with toolHandler and imported by handlers.ts. Each tool
// is an effect kind of its own, `tool:<name>`, so each states its own mode
// and time limit.
//
// A call goes: step finds the tool and checks the arguments; `prepare`
// answers it at once or lets it run; the handler reads the arguments from
// the reply in the log and does the I/O; `result` turns what it returns
// into the tool result the model reads. `prepare`, `result` and
// `unfinished` are optional: a plain tool is its definition and its handler.

import type { ContentPart } from '@acentric/llm';
import type { FailureCode, Json, Mode } from '@acentric/types';
import { Type } from 'typebox';
import type { Static, TProperties, TSchema } from 'typebox';

import type { ToolsSettings } from './settings.js';
import type { ToolsState } from './state.js';

/** What the model reads back from a call. */
export type ToolOutput = { content: string | ContentPart[]; isError?: boolean };

/** A hook's output, and optionally the tools part of the snapshot to keep from now on. */
export type ToolReply = ToolOutput & { state?: ToolsState };

/** What `prepare` sees: the tools' settings and state, and the step's time. */
export type ToolContext = {
  readonly settings: ToolsSettings;
  readonly state: ToolsState;
  readonly now: number;
};

/** What `result` and `unfinished` see: the call's arguments and what `prepare` passed on too. */
export type SettleContext<A, E> = ToolContext & { readonly args: A; readonly extra: E };

/**
 * What `prepare` decides: run the call, passing `extra` to its handler, or
 * answer it now with no I/O. Either way it may replace the tools part of
 * the snapshot, such as to record a command it starts.
 */
export type Prepared<E> =
  | { readonly run: E; readonly state?: ToolsState }
  | { readonly answer: ToolOutput; readonly state?: ToolsState };

/** Why a call's effect gave no result: a runner failure, or a `once` call cut off by a crash. */
export type ToolFailure = { readonly code: FailureCode | 'interrupted'; readonly error: Json };

/** What a call passes on when a tool has no `prepare`. */
export type NoExtra = Record<string, never>;

/**
 * A tool. `S` is its parameters' schema, `E` what `prepare` passes its
 * handler, and `R` what its handler returns. The hooks are methods, so a
 * tool with its own types still fits where any tool does.
 */
export type ToolDef<
  N extends string = string,
  S extends TSchema = TSchema,
  E extends Json = Json,
  R extends Json = Json,
> = {
  readonly name: N;
  /** What the model reads to decide when to call it. Keep it stable: a change invalidates prompt caches. */
  readonly description: string;
  /** The arguments' JSON Schema, sent to the model and checked in step. */
  readonly parameters: S;
  /** Whether a call may run again after a crash: reissue to read, once to change the world. */
  readonly mode: Mode;
  /** The handler's time limit for one run, in milliseconds. */
  readonly timeoutMs?: number;
  /** Runs of one reissue call after crashes before it fails with attempts_exhausted. */
  readonly maxAttempts?: number;
  /**
   * How its calls run beside the reply's others. Parallel by default;
   * sequential runs a call alone, after the calls before it and before the
   * calls after it.
   */
  readonly concurrency?: 'parallel' | 'sequential';
  /** Calls with the same key run one at a time, such as edits to one file. */
  resourceKey?(args: Static<S>): string;
  prepare?(args: Static<S>, ctx: ToolContext): Prepared<E>;
  /** Turns the handler's result into what the model reads. Without it, a result that is a ToolOutput is used as it is. */
  result?(output: R, ctx: SettleContext<Static<S>, E>): ToolReply;
  /** What the model reads when the call gave no result. Without it, a sentence describing the failure. */
  unfinished?(failure: ToolFailure, ctx: SettleContext<Static<S>, E>): ToolReply;
};

/** Any tool, its types erased: what the loop and the tool list work with. */
export type AnyTool = ToolDef;

/**
 * Defines a tool from its parameters' fields. `E` is read from what
 * `prepare` runs with, and `R` from what `result` takes; without them, a
 * tool passes nothing on and its handler returns a ToolOutput.
 */
export function defineTool<
  const N extends string,
  P extends TProperties,
  E extends Json = NoExtra,
  R extends Json = ToolOutput,
>(spec: Omit<ToolDef<N, ReturnType<typeof objectOf<P>>, E, R>, 'parameters'> & { parameters: P }) {
  const parameters = objectOf(spec.parameters);
  return { ...spec, parameters } satisfies ToolDef<N, typeof parameters, E, R>;
}

/** A tool's parameters' schema: its fields, and nothing else. */
function objectOf<P extends TProperties>(fields: P) {
  return Type.Object(fields, { additionalProperties: false });
}

/** A tool's effect kind. */
export type ToolKind<N extends string> = `tool:${N}`;

export function toolKind<N extends string>(name: N): ToolKind<N> {
  return `tool:${name}`;
}

/**
 * A tool call's effect args. They point at the call in the log rather than
 * copy its arguments, which can be large, such as a whole file to write.
 */
export type ToolEffectArgs<E extends Json = Json> = {
  /** The assistant entry whose reply made the call. */
  replySeq: number;
  callId: string;
  /** What `prepare` passed on. */
  extra: E;
};
