// Reading an answer of Anthropic's. Nothing here changes the answer, which is sent back as it is.

import type { JsonObject } from '@acentric/protocol';

import type { ToolCall } from '../runner.ts';

/** What the answer says. Text that was split around citations is joined as it was written. */
export function outputText(blocks: readonly JsonObject[]): string {
  return blocks
    .map((block) =>
      block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : '',
    )
    .join('');
}

/** What the answer gives of its thinking, in order. */
export function reasoningSummary(blocks: readonly JsonObject[]): string[] {
  return blocks.flatMap((block) => {
    const thinking = block['thinking'];
    return block['type'] === 'thinking' && typeof thinking === 'string' && thinking !== ''
      ? [thinking]
      : [];
  });
}

/**
 * The calls of the engine's tools. The tools Anthropic runs itself are answered within the
 * same message, and are not here.
 */
export function toolCalls(blocks: readonly JsonObject[]): ToolCall[] {
  return blocks.flatMap((block): ToolCall[] => {
    const { id, name, toolset_name: toolset } = block;
    if (block['type'] !== 'tool_use' || typeof id !== 'string' || typeof name !== 'string')
      return [];
    return [
      {
        id,
        name,
        arguments: block['input'] ?? {},
        // The result of a call of a toolset's tool names the toolset.
        ...(typeof toolset === 'string' ? { resultOptions: { toolset_name: toolset } } : {}),
      },
    ];
  });
}
