// Readers over a Responses assistant message (OpenAI, Fireworks). They never
// change the message, which is sent back as it is.

import type { Json, JsonObject } from '@acentric/types';

import { isArray, isObject } from '../json.js';

/** What a reader returns for one call, before it is typed for its provider. */
export type ReadCall = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolType: 'function' | 'custom' | 'native';
  readonly arguments?: string;
  readonly input?: string;
  readonly namespace?: string;
  readonly async?: boolean;
  readonly resultOptions?: JsonObject;
  readonly itemType: string;
  readonly item: JsonObject;
};

export type TextOptions = {
  /** `final`, the default, leaves out commentary, which is a progress update and not the answer. */
  readonly phase?: 'final' | 'all';
};

/** Item types answered with a `tool_result` message, and the tool type they answer. */
const RESULT_CALLS: { readonly [type: string]: 'function' | 'custom' } = {
  function_call: 'function',
  custom_tool_call: 'custom',
};

/** Provider-defined calls the caller runs and answers with a `native` message. */
const NATIVE_CALLS: ReadonlySet<string> = new Set([
  'computer_call',
  'shell_call',
  'apply_patch_call',
  'local_shell_call',
  'tool_search_call',
  'mcp_approval_request',
]);

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

export function outputText(items: readonly Json[], { phase = 'final' }: TextOptions = {}): string {
  return messages(items)
    .filter((message) => phase === 'all' || message['phase'] !== 'commentary')
    .map((message) =>
      parts(message)
        .map((part) => (part['type'] === 'output_text' ? text(part['text']) : ''))
        .join(''),
    )
    .filter((joined) => joined !== '')
    .join('\n\n');
}

export function refusals(items: readonly Json[]): string[] {
  return messages(items).flatMap((message) =>
    parts(message).flatMap((part) => {
      const refusal = part['refusal'];
      return part['type'] === 'refusal' && typeof refusal === 'string' ? [refusal] : [];
    }),
  );
}

export function reasoningSummary(items: readonly Json[]): string[] {
  return items.flatMap((item) => {
    if (!isObject(item) || item['type'] !== 'reasoning') return [];
    const summary = item['summary'];
    if (!isArray(summary)) return [];
    return summary.flatMap((part) =>
      isObject(part) && typeof part['text'] === 'string' ? [part['text']] : [],
    );
  });
}

/** Every call the caller answers, answered within the message or not. */
export function toolCalls(items: readonly Json[]): ReadCall[] {
  const calls: ReadCall[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const type = item['type'];
    if (typeof type !== 'string') continue;
    const toolType = RESULT_CALLS[type] ?? (NATIVE_CALLS.has(type) ? 'native' : undefined);
    if (toolType === undefined) continue;
    // Tool search that runs at the provider has no call to answer.
    if (type === 'tool_search_call' && item['execution'] !== 'client') continue;
    const id = type === 'mcp_approval_request' ? item['id'] : item['call_id'];
    if (typeof id !== 'string' || id === '') continue;
    calls.push(toCall(item, type, id, toolType));
  }
  return calls;
}

/** Calls with no answer in the message itself, as a hosted shell call has in its output. */
export function pendingToolCalls(items: readonly Json[]): ReadCall[] {
  const answered = new Set<string>();
  for (const item of items) {
    if (!isObject(item)) continue;
    const type = item['type'];
    const request = item['approval_request_id'];
    const callId = item['call_id'];
    if (type === 'mcp_approval_response' && typeof request === 'string') answered.add(request);
    else if (typeof type === 'string' && type.endsWith('_output') && typeof callId === 'string')
      answered.add(callId);
  }
  return toolCalls(items).filter((call) => !answered.has(call.toolCallId));
}

function toCall(
  item: JsonObject,
  type: string,
  id: string,
  toolType: ReadCall['toolType'],
): ReadCall {
  const name = item['name'];
  const namespace = item['namespace'];
  const serverLabel = item['server_label'];
  const args = item['arguments'];
  const input = item['input'];
  const caller = item['caller'];
  const callNamespace =
    typeof namespace === 'string'
      ? namespace
      : type === 'mcp_approval_request' && typeof serverLabel === 'string'
        ? serverLabel
        : undefined;
  // A result must repeat the call's caller (programmatic tool calling) and may name its namespace.
  const resultOptions: JsonObject = {
    ...(isObject(caller) ? { caller } : {}),
    ...(toolType === 'function' && typeof namespace === 'string' ? { namespace } : {}),
  };
  return {
    toolCallId: id,
    toolName: typeof name === 'string' ? name : type.replace(/_call$/, ''),
    toolType,
    ...(typeof args === 'string' && toolType !== 'native' ? { arguments: args } : {}),
    ...(typeof input === 'string' ? { input } : {}),
    ...(callNamespace === undefined ? {} : { namespace: callNamespace }),
    ...(item['async'] === true ? { async: true } : {}),
    ...(Object.keys(resultOptions).length > 0 ? { resultOptions } : {}),
    itemType: type,
    item,
  };
}

function text(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}
