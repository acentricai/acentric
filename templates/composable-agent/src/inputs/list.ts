// The inputs the agent takes, and the check step runs on each one a caller
// sends. An agent adds its own inputs here, or replaces these.

import type { UserMessage } from '@acentric/llm';
import { Value } from 'typebox/value';

import { problems } from '../core/check.js';
import type { Delivery } from './config.js';
import type { InputDef } from './define.js';
import { interrupt } from './interrupt.js';
import { message } from './message.js';

export const INPUTS: readonly InputDef[] = [message, interrupt];

/** A caller's input, checked: a message to give the model, or a control input for step. */
export type Input =
  | { role: 'message'; kind: string; message: UserMessage; delivery: Delivery | undefined }
  | { role: 'control'; kind: string; payload: unknown };

/** The input if its kind is one of INPUTS and its payload fits, or what is wrong with it. */
export function readInput(kind: string, payload: unknown): { input: Input } | { error: string } {
  const def = INPUTS.find((input) => input.kind === kind);
  if (def === undefined) {
    const kinds = INPUTS.map((input) => input.kind).join(', ');
    return { error: `unknown input ${kind}: send one of ${kinds}` };
  }
  if (!Value.Check(def.payload, payload)) {
    return {
      error: `invalid ${kind} input: ${problems(def.payload, payload, 'payload').join('; ')}`,
    };
  }
  if (def.role === 'control') return { input: { role: 'control', kind, payload } };
  return { input: { role: 'message', kind, ...def.read(payload) } };
}
