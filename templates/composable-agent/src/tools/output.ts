// What the model reads when a tool leaves it to the template: a handler's
// result used as it is, and a sentence for a call that gave no result.

import type { Json } from '@acentric/types';

import type { ToolFailure, ToolOutput } from './define.js';

/** A tool without `result`: a ToolOutput is used as it is; anything else is shown as JSON. */
export function defaultOutput(result: Json): ToolOutput {
  if (isToolOutput(result)) return result;
  return { content: JSON.stringify(result) };
}

/** A tool without `unfinished`: what happened, so the model can decide what to do next. */
export function describeFailure(name: string, failure: ToolFailure): ToolOutput {
  return { content: failureText(name, failure), isError: true };
}

function failureText(name: string, { code, error }: ToolFailure): string {
  switch (code) {
    case 'interrupted':
      return `${name} was cut off and may or may not have finished; check before trying it again`;
    case 'threw':
      return `${name} failed: ${messageOf(error)}`;
    case 'timeout':
      return `${name} ran past its time limit`;
    case 'aborted':
      return `${name} was stopped by an interrupt`;
    case 'attempts_exhausted':
      return `${name} was cut off by restarts too many times, and was given up`;
    case 'unknown_kind':
      return `${name} has no handler`;
    case 'invalid_result':
      return `${name} returned something that is not JSON`;
    case 'limit_exceeded':
      return `${name}'s arguments or result were too large: ${messageOf(error)}`;
  }
}

/** The message of what a handler threw, as the runner made it JSON: usually `{ name, message }`. */
function messageOf(error: Json): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return JSON.stringify(error);
}

function isToolOutput(value: Json): value is ToolOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    (typeof value.content === 'string' || Array.isArray(value.content))
  );
}
