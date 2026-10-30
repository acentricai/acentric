// What the tests play the handlers with: tools to stand in for an agent's
// own, model replies, and failures as @acentric/llm reports them.

import type { Json, JsonObject } from '@acentric/types';
import { Type } from 'typebox';

import { defineTool } from '../src/tools/define.js';
import type { AnyTool } from '../src/tools/define.js';

/** Runs in parallel with no resource key. */
export const echo = defineTool({
  name: 'echo',
  description: 'Says the text back',
  parameters: { text: Type.String() },
  mode: 'reissue',
});

/** Edits to one path run one at a time. */
export const edit = defineTool({
  name: 'edit',
  description: 'Edits a file',
  parameters: { path: Type.String(), text: Type.String() },
  mode: 'once',
  resourceKey: (args) => args.path,
});

/** Runs alone. */
export const serial = defineTool({
  name: 'serial',
  description: 'Runs alone',
  parameters: { text: Type.String() },
  mode: 'reissue',
  concurrency: 'sequential',
});

/** Answered in step, with no effect. */
export const note = defineTool({
  name: 'note',
  description: 'Notes the text',
  parameters: { text: Type.String() },
  mode: 'reissue',
  prepare: (args) => ({ answer: { content: `noted: ${args.text}` } }),
});

export const TEST_TOOLS: readonly AnyTool[] = [echo, edit, serial, note];

/** A model's reply, as the `llm` handler returns it. */
export function reply(content: JsonObject[], stopReason = 'stop', usage?: JsonObject): Json {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    message: {
      role: 'assistant',
      provider: 'anthropic',
      api: 'anthropic-messages',
      model: 'claude-sonnet-5-5',
      content,
    },
    stopReason,
    native: {},
    durationMs: 1,
    timestamp: 0,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function text(value: string): JsonObject {
  return { type: 'text', text: value };
}

export function call(id: string, name: string, input: JsonObject): JsonObject {
  return { type: 'tool_use', id, name, input };
}

/** What an `llm` handler throws, as the runner reports it. */
export function llmError(kind: string, retryable: boolean, fields: JsonObject = {}): Json {
  return { name: 'LlmError', message: `the call failed: ${kind}`, kind, retryable, ...fields };
}
