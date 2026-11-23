// Reading what records carry: messages, answers and tool results. A model's answer is its
// provider's output as it came, in the format its `api` names: it is read here as the engine's
// own readers read it (packages/ai, responses/read.ts and anthropic/read.ts), since the
// dashboard does not depend on that package.

import type {
  AssistantMessage,
  Json,
  JsonObject,
  Message,
  NativeMessage,
  ToolResultMessage,
  Usage,
} from '@acentric/protocol';

import { firstLine } from '../../format.ts';

type ContentPart = Extract<Message, { role: 'user' }>['content'][number];

/** A call of a tool an answer makes. */
export type ToolCall = {
  readonly toolCallId: string;
  readonly toolName: string;
  /** What it was called with: JSON as it reads, or its text when it does not read. */
  readonly arguments: Json | string;
};

/** The text of a user, system or tool message's parts, joined. */
export function partsText(
  parts: readonly { readonly type: string; readonly text?: string }[],
): string {
  return parts.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('\n');
}

/** What a message says, as text: an assistant's answer is read as its format has it. */
export function messageText(message: Message): string {
  switch (message.role) {
    case 'user':
    case 'system':
    case 'tool_result':
      return partsText(message.content);
    case 'assistant':
      return readResponse(message).text;
    case 'native':
    case 'custom':
      return '';
  }
}

/** Images and files in a message's parts. */
export function media(message: Message): { images: number; files: number } {
  if (message.role !== 'user' && message.role !== 'system' && message.role !== 'tool_result') {
    return { images: 0, files: 0 };
  }
  let images = 0;
  let files = 0;
  for (const part of message.content) {
    if (part.type === 'image') images += 1;
    else if (part.type === 'file') files += 1;
  }
  return { images, files };
}

/** `image`, `2 images`, `file`, `2 files`, both with ` · `; empty for none. */
export function mediaLabel({ images, files }: { images: number; files: number }): string {
  const parts: string[] = [];
  if (images > 0) parts.push(images === 1 ? 'image' : `${String(images)} images`);
  if (files > 0) parts.push(files === 1 ? 'file' : `${String(files)} files`);
  return parts.join(' · ');
}

/** The first line of text across messages, or what media they hold. */
export function messagesHeadline(messages: readonly Message[]): string {
  for (const message of messages) {
    const line = firstLine(messageText(message));
    if (line !== '') return line;
  }
  const total = { images: 0, files: 0 };
  for (const message of messages) {
    const found = media(message);
    total.images += found.images;
    total.files += found.files;
  }
  return mediaLabel(total);
}

export type ResponseView = {
  readonly text: string;
  readonly thinking: readonly string[];
  readonly refusals: readonly string[];
  readonly calls: readonly ToolCall[];
  /** What the provider's own web search looked for, or the page it opened. */
  readonly searches: readonly string[];
};

/** Read once for each message: a long log is drawn again on every new record. */
const responses = new WeakMap<AssistantMessage, ResponseView>();

export function readResponse(message: AssistantMessage): ResponseView {
  const known = responses.get(message);
  if (known !== undefined) return known;
  const view = readFresh(message);
  responses.set(message, view);
  return view;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** A call's arguments as JSON when they parse, otherwise as the model wrote them. */
function argumentsOf(raw: Json | undefined): Json | string {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw === '' ? '{}' : raw) as Json;
  } catch {
    return raw;
  }
}

function readFresh(message: AssistantMessage): ResponseView {
  const items = message.content.filter(isObject);
  const searches = searchesOf(items);
  if (message.api === 'anthropic-messages') {
    return {
      text: items
        .map((block) => (block['type'] === 'text' ? (textOf(block['text']) ?? '') : ''))
        .join(''),
      thinking: items.flatMap((block) => {
        const thinking = textOf(block['thinking']);
        return block['type'] === 'thinking' && thinking !== undefined && thinking !== ''
          ? [thinking]
          : [];
      }),
      refusals: [],
      calls: items.flatMap((block): ToolCall[] => {
        const id = textOf(block['id']);
        const name = textOf(block['name']);
        if (block['type'] !== 'tool_use' || id === undefined || name === undefined) return [];
        return [{ toolCallId: id, toolName: name, arguments: block['input'] ?? {} }];
      }),
      searches,
    };
  }
  // The Responses format, which OpenAI, ChatGPT and Fireworks answer in.
  const messages = items.filter(
    (item) => item['type'] === 'message' && Array.isArray(item['content']),
  );
  const partsOf = (item: JsonObject) => (item['content'] as Json[]).filter(isObject);
  return {
    text: messages
      .filter((item) => item['phase'] !== 'commentary')
      .map((item) =>
        partsOf(item)
          .map((part) => (part['type'] === 'output_text' ? (textOf(part['text']) ?? '') : ''))
          .join(''),
      )
      .filter((joined) => joined !== '')
      .join('\n\n'),
    thinking: items.flatMap((item) => {
      const summary = item['summary'];
      if (item['type'] !== 'reasoning' || !Array.isArray(summary)) return [];
      return summary.flatMap((part) => {
        const text = isObject(part) ? textOf(part['text']) : undefined;
        return text === undefined ? [] : [text];
      });
    }),
    refusals: messages.flatMap((item) =>
      partsOf(item).flatMap((part) => {
        const refusal = textOf(part['refusal']);
        return part['type'] === 'refusal' ? [refusal ?? ''] : [];
      }),
    ),
    calls: items.flatMap((item): ToolCall[] => {
      const id = textOf(item['call_id']);
      const name = textOf(item['name']);
      if (item['type'] !== 'function_call' || id === undefined || id === '' || name === undefined)
        return [];
      return [{ toolCallId: id, toolName: name, arguments: argumentsOf(item['arguments']) }];
    }),
    searches,
  };
}

/** The searches of the provider's own web search in an answer: Anthropic's calls of it, and OpenAI's. */
function searchesOf(items: readonly JsonObject[]): string[] {
  const found: string[] = [];
  for (const item of items) {
    if (item['type'] === 'server_tool_use' && item['name'] === 'web_search') {
      const input = item['input'];
      found.push(isObject(input) ? (textOf(input['query']) ?? '') : '');
    }
    if (item['type'] === 'web_search_call') {
      const action = isObject(item['action']) ? item['action'] : {};
      const queries = Array.isArray(action['queries'])
        ? action['queries'].filter((one): one is string => typeof one === 'string')
        : [];
      found.push(textOf(action['query']) ?? queries[0] ?? textOf(action['url']) ?? '');
    }
  }
  return found;
}

/** The first argument's value, as a line: what a call is about, `src/app.ts`, `npm test`. */
export function firstArgument(args: Json | string | undefined): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return clip(firstLine(args));
  if (typeof args !== 'object') return clip(String(args));
  const value = Array.isArray(args) ? args[0] : Object.values(args)[0];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clip(firstLine(value));
  return clip(JSON.stringify(value));
}

function clip(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type ResultView = {
  readonly name: string;
  readonly isError: boolean;
  readonly text: string;
  readonly parts: readonly ContentPart[];
  /** A provider's own items, shown as JSON. */
  readonly native: readonly Json[] | null;
};

export function readResult(message: ToolResultMessage | NativeMessage): ResultView {
  if (message.role === 'tool_result') {
    return {
      name: message.toolName,
      isError: message.isError === true,
      text: partsText(message.content),
      parts: message.content,
      native: null,
    };
  }
  return { name: 'provider tool', isError: false, text: '', parts: [], native: message.content };
}

/** Prompt tokens, cached or not. */
export function inputTokens(usage: Usage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (usage.totalInput !== undefined) return usage.totalInput;
  if (usage.input === undefined && usage.cacheRead === undefined && usage.cacheWrite === undefined)
    return undefined;
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Image types a browser decodes as images. SVG is not one of them here: it can carry script. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/**
 * Where an image part is shown from: a `data:` URL for bytes in the message, the server's blob
 * route for bytes it keeps. Null when it is not one that is shown.
 */
export function imageSource(part: ContentPart, blob: (digest: string) => string): string | null {
  if (part.type !== 'image') return null;
  const { source } = part;
  if (source.type === 'blob') {
    return IMAGE_TYPES.has(source.mediaType.toLowerCase()) ? blob(source.digest) : null;
  }
  if (source.type !== 'base64') return null;
  const type = source.mediaType.toLowerCase();
  if (!IMAGE_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) return null;
  return `data:${type};base64,${source.data}`;
}
