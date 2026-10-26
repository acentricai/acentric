// The body of a Responses create-response request. Requests may come from
// a log or, at the gateway, from anyone, so every shape is checked as it is
// written, and anything the provider would drop without a word is refused.

import type { Json, JsonObject } from '@acentric/types';

import { isArray, isObject } from '../../json.js';
import type { LlmRequest } from '../../request.js';
import { invalidRequest, ownFields, plainText, show } from '../util.js';
import type { ResponsesProfile, ResponsesProvider } from './profile.js';

/** Request fields the request itself sets. */
const OWNED_OPTIONS = ['model', 'input', 'instructions'];

export function buildRequest<P extends ResponsesProvider>(
  request: LlmRequest<P>,
  profile: ResponsesProfile<P>,
): JsonObject {
  const { provider } = profile;
  const options = ownFields(provider, request.options, OWNED_OPTIONS, 'request', 'options');
  if (options['stream'] === true) {
    throw invalidRequest(
      provider,
      'streaming is not supported: a call returns one finished response',
    );
  }
  if (options['background'] === true) {
    throw invalidRequest(
      provider,
      'background mode is not supported: a call returns one finished response',
    );
  }
  const { tools: nativeTools, ...rest } = options;
  if (nativeTools !== undefined && !isArray(nativeTools)) {
    throw invalidRequest(provider, 'options.tools must be an array of native tool definitions');
  }
  const messages: Json = request.messages;
  if (!isArray(messages)) throw invalidRequest(provider, 'messages must be an array');
  const instructions = buildInstructions(provider, request.instructions);
  const tools = [
    ...(request.tools ?? []).map((tool, index) => buildTool(tool, `tools[${index}]`, profile)),
    ...(nativeTools ?? []),
  ];
  return {
    ...rest,
    model: request.model,
    ...(instructions === undefined ? {} : { instructions }),
    input: messages.flatMap((message, index) => buildItems(message, `messages[${index}]`, profile)),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function buildInstructions(provider: string, value: Json | undefined): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  if (!isArray(value))
    throw invalidRequest(provider, 'instructions must be a string or text parts');
  const texts = value.map((part, index) => {
    if (!isObject(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') {
      throw invalidRequest(provider, `instructions[${index}] must be a text part`);
    }
    if (part['providerOptions'] !== undefined) {
      throw invalidRequest(
        provider,
        `instructions[${index}].providerOptions is not taken: instructions are one string here. ` +
          'Send a system message for options such as a cache breakpoint',
      );
    }
    return part['text'];
  });
  return texts.length > 0 ? texts.join('\n\n') : undefined;
}

function buildItems<P extends ResponsesProvider>(
  message: Json,
  where: string,
  profile: ResponsesProfile<P>,
): Json[] {
  const { provider, label } = profile;
  if (!isObject(message)) throw invalidRequest(provider, `${where} must be a message`);
  switch (message['role']) {
    case 'user':
      return [
        { type: 'message', role: 'user', content: buildParts(message['content'], where, profile) },
      ];
    case 'system':
      return [
        {
          type: 'message',
          role: profile.systemRole,
          content: buildParts(message['content'], where, profile, true),
        },
      ];
    case 'assistant':
      if (message['provider'] !== provider) {
        throw invalidRequest(
          provider,
          `${where} is from ${show(message['provider'])}: convert it before sending it to ${label}`,
        );
      }
      return items(provider, message['content'], where).map((item) =>
        outputOnly(item, profile.outputOnlyFields),
      );
    case 'native':
      if (message['provider'] !== provider) {
        throw invalidRequest(
          provider,
          `${where} holds ${show(message['provider'])} items, which ${label} cannot take`,
        );
      }
      return items(provider, message['content'], where);
    case 'tool_result':
      return [buildToolResult(message, where, profile)];
    case 'custom':
      throw invalidRequest(
        provider,
        `${where} is the application's own: leave custom messages out`,
      );
    default:
      throw invalidRequest(provider, `${where} has an unknown role: ${show(message['role'])}`);
  }
}

function items(provider: string, value: Json | undefined, where: string): JsonObject[] {
  if (!isArray(value)) throw invalidRequest(provider, `${where}.content must be an array of items`);
  return value.map((item, index) => {
    if (!isObject(item) || typeof item['type'] !== 'string') {
      throw invalidRequest(provider, `${where}.content[${index}] must be an item with a type`);
    }
    return item;
  });
}

/** An output item without the fields the provider writes but refuses back. */
function outputOnly(item: JsonObject, fields: readonly string[]): JsonObject {
  if (!fields.some((field) => field in item)) return item;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !fields.includes(key)));
}

function buildToolResult<P extends ResponsesProvider>(
  message: JsonObject,
  where: string,
  profile: ResponsesProfile<P>,
): JsonObject {
  const { provider, label } = profile;
  const callId = message['toolCallId'];
  if (typeof callId !== 'string' || callId === '') {
    throw invalidRequest(provider, `${where}.toolCallId must be a string that is not empty`);
  }
  const toolType = message['toolType'] ?? 'function';
  if (toolType !== 'function' && toolType !== 'custom') {
    throw invalidRequest(provider, `${where}.toolType must be function or custom`);
  }
  if (toolType === 'custom' && !profile.customTools) {
    throw invalidRequest(provider, `${where} answers a custom tool, and ${label} has none`);
  }
  const fields = ownFields(
    provider,
    message['providerOptions'],
    ['type', 'call_id', 'output'],
    where,
  );
  return {
    ...fields,
    type: toolType === 'function' ? 'function_call_output' : 'custom_tool_call_output',
    call_id: callId,
    output: plainText(message['content']) ?? buildParts(message['content'], where, profile),
  };
}

function buildParts<P extends ResponsesProvider>(
  value: Json | undefined,
  where: string,
  profile: ResponsesProfile<P>,
  textOnly = false,
): JsonObject[] {
  const { provider } = profile;
  if (!isArray(value)) throw invalidRequest(provider, `${where}.content must be an array of parts`);
  return value.map((part, index) => {
    const at = `${where}.content[${index}]`;
    if (!isObject(part)) throw invalidRequest(provider, `${at} must be a content part`);
    if (textOnly && part['type'] !== 'text')
      throw invalidRequest(provider, `${at} must be a text part`);
    return buildPart(part, at, profile);
  });
}

function buildPart<P extends ResponsesProvider>(
  part: JsonObject,
  at: string,
  profile: ResponsesProfile<P>,
): JsonObject {
  const { provider, label } = profile;
  const options = part['providerOptions'];
  switch (part['type']) {
    case 'text': {
      const text = part['text'];
      if (typeof text !== 'string') throw invalidRequest(provider, `${at}.text must be a string`);
      return { ...ownFields(provider, options, ['type', 'text'], at), type: 'input_text', text };
    }
    case 'image': {
      const fields = ownFields(provider, options, ['type', 'image_url', 'file_id'], at);
      const source = checkSource(part['source'], at, profile);
      return {
        ...fields,
        type: 'input_image',
        ...(source.type === 'url'
          ? { image_url: source.url }
          : source.type === 'base64'
            ? { image_url: dataUrl(source.mediaType, source.data) }
            : { file_id: source.id }),
      };
    }
    case 'file': {
      if (!profile.files) {
        throw invalidRequest(provider, `${at} is a file, which ${label} would drop without a word`);
      }
      const owned = ['type', 'file_url', 'file_data', 'file_id', 'filename'];
      const fields = ownFields(provider, options, owned, at);
      const source = checkSource(part['source'], at, profile);
      const filename = part['filename'];
      if (filename !== undefined && typeof filename !== 'string') {
        throw invalidRequest(provider, `${at}.filename must be a string`);
      }
      return {
        ...fields,
        type: 'input_file',
        ...(source.type === 'url'
          ? { file_url: source.url }
          : source.type === 'base64'
            ? { file_data: dataUrl(source.mediaType, source.data) }
            : { file_id: source.id }),
        ...(filename === undefined ? {} : { filename }),
      };
    }
    default:
      throw invalidRequest(provider, `${at} has an unknown type: ${show(part['type'])}`);
  }
}

type Source =
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
  | { readonly type: 'file_id'; readonly id: string };

function checkSource<P extends ResponsesProvider>(
  source: Json | undefined,
  at: string,
  profile: ResponsesProfile<P>,
): Source {
  const { provider, label } = profile;
  if (isObject(source)) {
    const { type, url, id, data, mediaType } = source;
    if (type === 'url' && typeof url === 'string') return { type, url };
    if (type === 'base64' && typeof data === 'string' && typeof mediaType === 'string') {
      return { type, mediaType, data };
    }
    if (type === 'file_id' && typeof id === 'string') {
      if (!profile.fileIds) {
        throw invalidRequest(
          provider,
          `${at}.source is a file ID, which ${label} cannot take: send a URL or base64 data`,
        );
      }
      return { type, id };
    }
  }
  throw invalidRequest(provider, `${at}.source must be a url, base64 or file_id source`);
}

function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

function buildTool<P extends ResponsesProvider>(
  tool: Json,
  where: string,
  profile: ResponsesProfile<P>,
): JsonObject {
  const { provider, label } = profile;
  if (
    !isObject(tool) ||
    typeof tool['name'] !== 'string' ||
    typeof tool['description'] !== 'string'
  ) {
    throw invalidRequest(provider, `${where} needs a type, a name and a description`);
  }
  const { name, description, parameters, strict, format } = tool;
  const at = `tool ${name}`;
  if (tool['type'] === 'function') {
    const owned = ['type', 'name', 'description', 'parameters', 'strict'];
    const fields = ownFields(provider, tool['providerOptions'], owned, at);
    if (!isObject(parameters))
      throw invalidRequest(provider, `${at}: parameters must be a JSON Schema object`);
    // A `strict` left out stays out: the provider treats it differently from false.
    return {
      ...fields,
      type: 'function',
      name,
      description,
      parameters,
      ...(strict === undefined ? {} : { strict }),
    };
  }
  if (tool['type'] === 'custom') {
    if (!profile.customTools) {
      throw invalidRequest(
        provider,
        `${at} is a custom tool, which ${label} cannot take: use a function tool`,
      );
    }
    const fields = ownFields(
      provider,
      tool['providerOptions'],
      ['type', 'name', 'description', 'format'],
      at,
    );
    return {
      ...fields,
      type: 'custom',
      name,
      description,
      ...(format === undefined ? {} : { format }),
    };
  }
  throw invalidRequest(provider, `${where} has an unknown type: ${show(tool['type'])}`);
}
