// The Anthropic Messages format's side of conversion.

import type { Json, JsonObject } from '@acentric/types';

import { isArray, isObject } from '../json.js';
import type { Common, Context, FormatConverter } from './types.js';

/** Signed reasoning the target cannot use: dropped, or kept as text. */
function carryReasoning(text: string, context: Context): JsonObject | undefined {
  if (context.reasoning === 'drop' || text === '') {
    context.change('dropped', 'reasoning', text === '' ? 'no readable text' : 'bound to its model');
    return undefined;
  }
  context.change('rewritten', 'reasoning', 'as assistant text');
  return { type: 'text', text };
}

/** Anthropic takes a call's input only as an object; anything else is wrapped. */
function toolInput(args: string, context: Context): JsonObject {
  try {
    const parsed: Json = JSON.parse(args);
    if (isObject(parsed)) return parsed;
  } catch {
    // Wrapped below.
  }
  context.change('rewritten', 'tool_arguments', 'not a JSON object: wrapped as { arguments }');
  return { arguments: args };
}

function string(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

export const anthropicConverter: FormatConverter = {
  sameFormat(items, sameProvider, context) {
    const out: JsonObject[] = [];
    for (const block of items) {
      const type = block['type'];
      // Signed thinking from another model is read by some models and silently
      // ignored by others, so it never moves between models.
      if (type === 'thinking' || type === 'redacted_thinking') {
        const carried = carryReasoning(string(block['thinking']), context);
        if (carried !== undefined) out.push(carried);
      } else if (sameProvider || type === 'text' || type === 'tool_use') {
        out.push(block);
      } else {
        context.change('dropped', 'provider_item', string(type) || 'unknown');
      }
    }
    return out;
  },

  read(items, context) {
    return items.map((block): Common => {
      switch (block['type']) {
        case 'text': {
          const citations = block['citations'];
          if (isArray(citations) && citations.length > 0) {
            context.change('dropped', 'citations', `${citations.length} citations`);
          }
          return { kind: 'text', text: string(block['text']) };
        }
        case 'thinking':
          return { kind: 'reasoning', text: string(block['thinking']) };
        case 'redacted_thinking':
          return { kind: 'reasoning', text: '' };
        case 'tool_use':
          return {
            kind: 'call',
            id: string(block['id']),
            name: string(block['name']),
            arguments: JSON.stringify(block['input'] ?? {}),
          };
        default:
          return { kind: 'other', type: string(block['type']) || 'unknown' };
      }
    });
  },

  write(items, context) {
    const out: JsonObject[] = [];
    for (const item of items) {
      switch (item.kind) {
        case 'text':
          // Anthropic refuses empty text blocks.
          if (item.text !== '') out.push({ type: 'text', text: item.text });
          break;
        case 'refusal':
          context.change('rewritten', 'refusal', 'as assistant text');
          if (item.text !== '') out.push({ type: 'text', text: item.text });
          break;
        case 'reasoning': {
          const carried = carryReasoning(item.text, context);
          if (carried !== undefined) out.push(carried);
          break;
        }
        case 'call':
          out.push({
            type: 'tool_use',
            id: context.callId(item.id),
            name: item.name,
            input: toolInput(item.arguments, context),
          });
          break;
        case 'custom_call':
          context.droppedCalls.add(item.id);
          context.change('dropped', 'tool_call', `custom tool ${item.name}`);
          break;
        case 'other':
          context.change('dropped', 'provider_item', item.type);
      }
    }
    return out;
  },
};
