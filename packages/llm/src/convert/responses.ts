// The Responses format's side of conversion (OpenAI, Fireworks).

import type { Json, JsonObject } from '@acentric/types';

import { isArray, isObject } from '../json.js';
import type { Common, Context, FormatConverter } from './types.js';

function texts(value: Json | undefined): string[] {
  return isArray(value)
    ? value.flatMap((part) =>
        isObject(part) && typeof part['text'] === 'string' ? [part['text']] : [],
      )
    : [];
}

/** A reasoning item's readable text: its summary, or else its reasoning text. */
function reasoningText(item: JsonObject): string {
  const summary = texts(item['summary']);
  return (summary.length > 0 ? summary : texts(item['content'])).join('\n\n');
}

function message(content: JsonObject[]): JsonObject {
  return { type: 'message', role: 'assistant', content };
}

function outputText(text: string): JsonObject {
  return { type: 'output_text', text, annotations: [] };
}

/** Reasoning the target cannot use as it is: dropped, or kept as text. */
function carryReasoning(text: string, context: Context): JsonObject | undefined {
  if (context.reasoning === 'drop' || text === '') {
    context.change('dropped', 'reasoning', text === '' ? 'no readable text' : 'bound to its model');
    return undefined;
  }
  if (context.target.plainReasoning) {
    context.change('rewritten', 'reasoning', 'as a plain reasoning item');
    return { type: 'reasoning', summary: [{ type: 'summary_text', text }] };
  }
  context.change('rewritten', 'reasoning', 'as assistant text');
  return message([outputText(text)]);
}

/** An item without the IDs and status its provider gave it. */
function withoutIds(item: JsonObject): JsonObject {
  const { id: _id, status: _status, ...rest } = item;
  return rest;
}

function string(value: Json | undefined, otherwise: string): string {
  return typeof value === 'string' ? value : otherwise;
}

export const responsesConverter: FormatConverter = {
  sameFormat(items, sameProvider, context) {
    const out: JsonObject[] = [];
    for (const item of items) {
      switch (item['type']) {
        case 'message':
          out.push(sameProvider ? item : withoutIds(item));
          break;
        case 'reasoning': {
          // A provider's own plain reasoning reads the same on any of its models.
          const encrypted = item['encrypted_content'];
          if (sameProvider && context.target.plainReasoning && !encrypted) {
            out.push(item);
            break;
          }
          const carried = carryReasoning(reasoningText(item), context);
          if (carried !== undefined) out.push(carried);
          break;
        }
        case 'function_call':
          out.push(
            sameProvider
              ? item
              : {
                  type: 'function_call',
                  call_id: string(item['call_id'], ''),
                  name: string(item['name'], ''),
                  arguments: string(item['arguments'], '{}'),
                },
          );
          break;
        case 'custom_tool_call':
          if (context.target.customTools) {
            out.push(sameProvider ? item : withoutIds(item));
          } else {
            const callId = item['call_id'];
            if (typeof callId === 'string') context.droppedCalls.add(callId);
            context.change('dropped', 'tool_call', `custom tool ${string(item['name'], '')}`);
          }
          break;
        default:
          if (sameProvider) out.push(item);
          else context.change('dropped', 'provider_item', string(item['type'], 'unknown'));
      }
    }
    return out;
  },

  read(items, context) {
    const common: Common[] = [];
    for (const item of items) {
      switch (item['type']) {
        case 'message': {
          const content = item['content'];
          for (const part of isArray(content) ? content : []) {
            if (!isObject(part)) continue;
            const text = part['text'];
            const refusal = part['refusal'];
            if (part['type'] === 'output_text' && typeof text === 'string') {
              const annotations = part['annotations'];
              if (isArray(annotations) && annotations.length > 0) {
                context.change('dropped', 'citations', `${annotations.length} annotations`);
              }
              common.push({ kind: 'text', text });
            } else if (part['type'] === 'refusal' && typeof refusal === 'string') {
              common.push({ kind: 'refusal', text: refusal });
            } else {
              common.push({ kind: 'other', type: `message ${string(part['type'], 'part')}` });
            }
          }
          break;
        }
        case 'reasoning':
          common.push({ kind: 'reasoning', text: reasoningText(item) });
          break;
        case 'function_call':
          common.push({
            kind: 'call',
            id: string(item['call_id'], ''),
            name: string(item['name'], ''),
            arguments: string(item['arguments'], '{}'),
          });
          break;
        case 'custom_tool_call':
          common.push({
            kind: 'custom_call',
            id: string(item['call_id'], ''),
            name: string(item['name'], ''),
            input: string(item['input'], ''),
          });
          break;
        default:
          common.push({ kind: 'other', type: string(item['type'], 'unknown') });
      }
    }
    return common;
  },

  write(items, context) {
    const out: JsonObject[] = [];
    let open: JsonObject[] = [];
    const close = () => {
      if (open.length > 0) out.push(message(open));
      open = [];
    };
    for (const item of items) {
      switch (item.kind) {
        case 'text':
          open.push(outputText(item.text));
          break;
        case 'refusal':
          open.push({ type: 'refusal', refusal: item.text });
          break;
        case 'reasoning': {
          close();
          const carried = carryReasoning(item.text, context);
          if (carried !== undefined) out.push(carried);
          break;
        }
        case 'call':
          close();
          out.push({
            type: 'function_call',
            call_id: context.callId(item.id),
            name: item.name,
            arguments: item.arguments,
          });
          break;
        case 'custom_call':
          close();
          if (context.target.customTools) {
            out.push({
              type: 'custom_tool_call',
              call_id: context.callId(item.id),
              name: item.name,
              input: item.input,
            });
          } else {
            context.droppedCalls.add(item.id);
            context.change('dropped', 'tool_call', `custom tool ${item.name}`);
          }
          break;
        case 'other':
          context.change('dropped', 'provider_item', item.type);
      }
    }
    close();
    return out;
  },
};
