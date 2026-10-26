// Readers over an Anthropic assistant message. They never change the message,
// which is sent back as it is.

import type { Json, JsonObject } from '@acentric/types';

import { isObject } from '../json.js';
import type { ReadCall } from './responses.js';

function blocks(items: readonly Json[]): JsonObject[] {
  return items.filter(isObject);
}

/** Text blocks split around citations are joined as written. */
export function outputText(items: readonly Json[]): string {
  return blocks(items)
    .map((block) => {
      const text = block['text'];
      return block['type'] === 'text' && typeof text === 'string' ? text : '';
    })
    .join('');
}

/** Anthropic reports a refusal as the stop reason, not as content. */
export function refusals(): string[] {
  return [];
}

/** Empty unless the request asked for `display: "summarized"`. */
export function reasoningSummary(items: readonly Json[]): string[] {
  return blocks(items).flatMap((block) => {
    const thinking = block['thinking'];
    return block['type'] === 'thinking' && typeof thinking === 'string' && thinking !== ''
      ? [thinking]
      : [];
  });
}

/**
 * Calls to the caller's tools. Server tools (`server_tool_use`, `mcp_tool_use`)
 * run at Anthropic and are answered in the same message, so they are not here,
 * and every call here is pending.
 */
export function toolCalls(items: readonly Json[]): ReadCall[] {
  return blocks(items).flatMap((block): ReadCall[] => {
    const id = block['id'];
    const name = block['name'];
    const toolset = block['toolset_name'];
    if (block['type'] !== 'tool_use' || typeof id !== 'string' || typeof name !== 'string') {
      return [];
    }
    return [
      {
        toolCallId: id,
        toolName: name,
        toolType: 'function',
        arguments: JSON.stringify(block['input'] ?? {}),
        // A toolset member's result must name its toolset.
        ...(typeof toolset === 'string' ? { resultOptions: { toolset_name: toolset } } : {}),
        itemType: 'tool_use',
        item: block,
      },
    ];
  });
}
