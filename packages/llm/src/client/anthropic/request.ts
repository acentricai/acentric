// The body of an Anthropic create-message request. Each of the request's
// messages becomes one Anthropic message. As for the Responses format, every
// shape is checked as it is written.

import type { Json, JsonObject } from '@acentric/types';

import { isArray, isObject } from '../../json.js';
import { findModel } from '../../models.js';
import type { LlmRequest } from '../../request.js';
import { invalidRequest, ownFields, plainText, show } from '../util.js';

const PROVIDER = 'anthropic';
const LABEL = 'Anthropic';

/** Request fields the request itself sets. */
const OWNED_OPTIONS = ['model', 'messages', 'system'];

/** The output limit for a model the catalog does not know: the Claude 5 maximum. */
const DEFAULT_MAX_TOKENS = 128_000;

export type AnthropicRequest = {
  readonly body: JsonObject;
  /** Beta names, for the `anthropic-beta` header. */
  readonly betas: readonly string[];
};

export function buildRequest(request: LlmRequest<'anthropic'>): AnthropicRequest {
  const options = ownFields(PROVIDER, request.options, OWNED_OPTIONS, 'request', 'options');
  if (options['stream'] === true) {
    throw invalidRequest(
      PROVIDER,
      'streaming is not supported: a call returns one finished response',
    );
  }
  const { tools: nativeTools, betas, ...rest } = options;
  if (nativeTools !== undefined && !isArray(nativeTools)) {
    throw invalidRequest(PROVIDER, 'options.tools must be an array of native tool definitions');
  }
  const messages: Json = request.messages;
  if (!isArray(messages)) throw invalidRequest(PROVIDER, 'messages must be an array');
  const tools = [
    ...(request.tools ?? []).map((tool, index) => buildTool(tool, `tools[${index}]`)),
    ...(nativeTools ?? []),
  ];
  const system = buildSystem(request.instructions);
  const maxTokens =
    rest['max_tokens'] ?? findModel(PROVIDER, request.model)?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  return {
    body: {
      ...rest,
      model: request.model,
      max_tokens: maxTokens,
      ...(system === undefined ? {} : { system }),
      messages: messages.flatMap((message, index) =>
        buildMessage(message, `messages[${index}]`, request.model),
      ),
      ...(tools.length > 0 ? { tools } : {}),
    },
    betas: readBetas(betas),
  };
}

function readBetas(value: Json | undefined): string[] {
  if (value === undefined) return [];
  if (isArray(value)) {
    const names = value.filter(
      (name): name is string => typeof name === 'string' && /^[\w.-]+$/.test(name),
    );
    if (names.length === value.length) return names;
  }
  throw invalidRequest(
    PROVIDER,
    'options.betas must be an array of beta names, such as "compact-2026-01-12"',
  );
}

/** A string stays a string; text parts become blocks, which may carry `cache_control`. */
function buildSystem(value: Json | undefined): Json | undefined {
  if (value === undefined || typeof value === 'string') return value;
  if (!isArray(value))
    throw invalidRequest(PROVIDER, 'instructions must be a string or text parts');
  return value.map((part, index) => textBlock(part, `instructions[${index}]`));
}

function buildMessage(message: Json, where: string, model: string): JsonObject[] {
  if (!isObject(message)) throw invalidRequest(PROVIDER, `${where} must be a message`);
  switch (message['role']) {
    case 'user':
      return [{ role: 'user', content: buildParts(message['content'], where) }];
    case 'system': {
      const content = message['content'];
      if (!isArray(content))
        throw invalidRequest(PROVIDER, `${where}.content must be an array of text parts`);
      return [
        {
          role: 'system',
          content: content.map((part, index) => textBlock(part, `${where}.content[${index}]`)),
        },
      ];
    }
    case 'assistant': {
      if (message['provider'] !== PROVIDER) {
        throw invalidRequest(
          PROVIDER,
          `${where} is from ${show(message['provider'])}: convert it before sending it to ${LABEL}`,
        );
      }
      const content = blocks(message['content'], where);
      if (message['model'] === model) return [{ role: 'assistant', content }];
      // Another model's thinking is bound to it: some models read it, others
      // ignore it without a word. Its other blocks are sent as written.
      const kept = content.filter(
        (block) => block['type'] !== 'thinking' && block['type'] !== 'redacted_thinking',
      );
      return kept.length > 0 ? [{ role: 'assistant', content: kept }] : [];
    }
    case 'native':
      if (message['provider'] !== PROVIDER) {
        throw invalidRequest(
          PROVIDER,
          `${where} holds ${show(message['provider'])} items, which ${LABEL} cannot take`,
        );
      }
      return [{ role: 'user', content: blocks(message['content'], where) }];
    case 'tool_result':
      return [{ role: 'user', content: [buildToolResult(message, where)] }];
    case 'custom':
      throw invalidRequest(
        PROVIDER,
        `${where} is the application's own: leave custom messages out`,
      );
    default:
      throw invalidRequest(PROVIDER, `${where} has an unknown role: ${show(message['role'])}`);
  }
}

function blocks(value: Json | undefined, where: string): JsonObject[] {
  if (!isArray(value))
    throw invalidRequest(PROVIDER, `${where}.content must be an array of blocks`);
  return value.map((block, index) => {
    if (!isObject(block) || typeof block['type'] !== 'string') {
      throw invalidRequest(PROVIDER, `${where}.content[${index}] must be a block with a type`);
    }
    return block;
  });
}

function buildToolResult(message: JsonObject, where: string): JsonObject {
  const callId = message['toolCallId'];
  if (typeof callId !== 'string' || callId === '') {
    throw invalidRequest(PROVIDER, `${where}.toolCallId must be a string that is not empty`);
  }
  const toolType = message['toolType'] ?? 'function';
  if (toolType === 'custom')
    throw invalidRequest(PROVIDER, `${where} answers a custom tool, and ${LABEL} has none`);
  if (toolType !== 'function')
    throw invalidRequest(PROVIDER, `${where}.toolType must be function or custom`);
  const isError = message['isError'];
  if (isError !== undefined && typeof isError !== 'boolean') {
    throw invalidRequest(PROVIDER, `${where}.isError must be true or false`);
  }
  const owned = ['type', 'tool_use_id', 'content', 'is_error'];
  return {
    ...ownFields(PROVIDER, message['providerOptions'], owned, where),
    type: 'tool_result',
    tool_use_id: callId,
    content: plainText(message['content']) ?? buildParts(message['content'], where),
    ...(isError === undefined ? {} : { is_error: isError }),
  };
}

function textBlock(part: Json, at: string): JsonObject {
  if (!isObject(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') {
    throw invalidRequest(PROVIDER, `${at} must be a text part`);
  }
  return {
    ...ownFields(PROVIDER, part['providerOptions'], ['type', 'text'], at),
    type: 'text',
    text: part['text'],
  };
}

function buildParts(value: Json | undefined, where: string): JsonObject[] {
  if (!isArray(value)) throw invalidRequest(PROVIDER, `${where}.content must be an array of parts`);
  return value.map((part, index) => buildPart(part, `${where}.content[${index}]`));
}

function buildPart(part: Json, at: string): JsonObject {
  if (!isObject(part)) throw invalidRequest(PROVIDER, `${at} must be a content part`);
  const options = part['providerOptions'];
  switch (part['type']) {
    case 'text':
      return textBlock(part, at);
    case 'image':
      return {
        ...ownFields(PROVIDER, options, ['type', 'source'], at),
        type: 'image',
        source: mediaSource(part['source'], at, false),
      };
    case 'file': {
      const filename = part['filename'];
      if (filename !== undefined && typeof filename !== 'string') {
        throw invalidRequest(PROVIDER, `${at}.filename must be a string`);
      }
      const owned = filename === undefined ? ['type', 'source'] : ['type', 'source', 'title'];
      return {
        ...ownFields(PROVIDER, options, owned, at),
        type: 'document',
        source: mediaSource(part['source'], at, true),
        ...(filename === undefined ? {} : { title: filename }),
      };
    }
    default:
      throw invalidRequest(PROVIDER, `${at} has an unknown type: ${show(part['type'])}`);
  }
}

/** A shared source as Anthropic's. A plain text document goes as text, the only way Anthropic takes it. */
function mediaSource(source: Json | undefined, at: string, document: boolean): JsonObject {
  if (isObject(source)) {
    const { type, url, id, data, mediaType } = source;
    if (type === 'url' && typeof url === 'string') return { type: 'url', url };
    if (type === 'file_id' && typeof id === 'string') return { type: 'file', file_id: id };
    if (type === 'base64' && typeof data === 'string' && typeof mediaType === 'string') {
      if (document && mediaType === 'text/plain') {
        return { type: 'text', media_type: 'text/plain', data: decodeText(data, at) };
      }
      return { type: 'base64', media_type: mediaType, data };
    }
  }
  throw invalidRequest(PROVIDER, `${at}.source must be a url, base64 or file_id source`);
}

function decodeText(base64: string, at: string): string {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest(PROVIDER, `${at}.source must hold UTF-8 text in base64 for text/plain`);
  }
}

function buildTool(tool: Json, where: string): JsonObject {
  if (
    !isObject(tool) ||
    typeof tool['name'] !== 'string' ||
    typeof tool['description'] !== 'string'
  ) {
    throw invalidRequest(PROVIDER, `${where} needs a type, a name and a description`);
  }
  const { name, description, parameters, strict } = tool;
  const at = `tool ${name}`;
  if (tool['type'] === 'custom') {
    throw invalidRequest(
      PROVIDER,
      `${at} is a custom tool, which ${LABEL} cannot take: use a function tool`,
    );
  }
  if (tool['type'] !== 'function')
    throw invalidRequest(PROVIDER, `${where} has an unknown type: ${show(tool['type'])}`);
  const owned = ['type', 'name', 'description', 'input_schema', 'strict'];
  const fields = ownFields(PROVIDER, tool['providerOptions'], owned, at);
  if (!isObject(parameters))
    throw invalidRequest(PROVIDER, `${at}: parameters must be a JSON Schema object`);
  return {
    ...fields,
    name,
    description,
    input_schema: parameters,
    ...(strict === undefined ? {} : { strict }),
  };
}
