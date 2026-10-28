// Reading a call's arguments: the JSON the model wrote, checked against the
// tool's parameters. Step does it before a call runs, and the handler again
// when it reads the arguments from the log, so both read them the same way.

import type { ToolCall } from '@acentric/llm';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { problems } from '../core/check.js';

/** The call's arguments if they parse and fit `parameters`, or what is wrong, for the model to read. */
export function parseArguments<S extends TSchema>(
  parameters: S,
  call: ToolCall,
): { args: Static<S> } | { error: string } {
  if (call.arguments === undefined) {
    return { error: `${call.toolName} takes JSON arguments` };
  }
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    return { error: `the arguments to ${call.toolName} are not valid JSON` };
  }
  if (Value.Check(parameters, value)) return { args: value };
  const found = problems(parameters, value, 'arguments').join('; ');
  return { error: `invalid arguments to ${call.toolName}: ${found}` };
}
