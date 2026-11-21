// Reading an answer in the Responses format. Nothing here changes the answer, which is sent
// back as it is.

import type { Json, JsonObject } from '@acentric/protocol';

import { isArray, isObject } from '../json.ts';
import type { ToolCall } from '../runner.ts';

function messages(items: readonly Json[]): JsonObject[] {
  return items.filter(
    (item): item is JsonObject =>
      isObject(item) && item['type'] === 'message' && isArray(item['content']),
  );
}

function parts(message: JsonObject): JsonObject[] {
  const content = message['content'];
  return isArray(content) ? content.filter(isObject) : [];
}

/** What the answer says. Commentary, which is word of progress and not the answer, is left out. */
export function outputText(items: readonly Json[]): string {
  return messages(items)
    .filter((message) => message['phase'] !== 'commentary')
    .map((message) =>
      parts(message)
        .map((part) =>
          part['type'] === 'output_text' && typeof part['text'] === 'string' ? part['text'] : '',
        )
        .join(''),
    )
    .filter((joined) => joined !== '')
    .join('\n\n');
}

/** Whether the model declined: it says so in a part of its message. */
export function refused(items: readonly Json[]): boolean {
  return messages(items).some((message) =>
    parts(message).some((part) => part['type'] === 'refusal'),
  );
}

/** What the answer gives of its reasoning, in order. Reasoning that is sealed stays in the answer. */
export function reasoningSummary(items: readonly Json[]): string[] {
  return items.flatMap((item) => {
    if (!isObject(item) || item['type'] !== 'reasoning' || !isArray(item['summary'])) return [];
    return item['summary'].flatMap((part) =>
      isObject(part) && typeof part['text'] === 'string' ? [part['text']] : [],
    );
  });
}

/** What a function call was called with: JSON as it reads, or its text when it does not read. */
function argumentsOf(text: Json | undefined): Json {
  if (typeof text !== 'string') return {};
  try {
    return JSON.parse(text === '' ? '{}' : text) as Json;
  } catch {
    return text;
  }
}

/** The calls of the engine's tools the answer makes: its function calls. */
export function toolCalls(items: readonly Json[]): ToolCall[] {
  return items.flatMap((item): ToolCall[] => {
    if (!isObject(item) || item['type'] !== 'function_call') return [];
    const { call_id: id, name, caller, namespace } = item;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string') return [];
    // A result says again who called, and names the call's namespace, where the call had them.
    const resultOptions = {
      ...(isObject(caller) ? { caller } : {}),
      ...(typeof namespace === 'string' ? { namespace } : {}),
    };
    return [
      {
        id,
        name,
        arguments: argumentsOf(item['arguments']),
        ...(Object.keys(resultOptions).length === 0 ? {} : { resultOptions }),
      },
    ];
  });
}
