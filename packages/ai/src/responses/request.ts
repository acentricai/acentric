// The body of a request in the Responses format, from a step. The messages of a conversation
// are checked where they are stored, so nothing is checked again here but what one provider
// takes and another does not.

import type { ContentPart, JsonObject, Message, ToolResultMessage } from '@acentric/protocol';

import { ModelFailure } from '../failure.ts';
import { omit } from '../json.ts';
import type { ModelStep } from '../runner.ts';
import type { ResponsesProfile } from './profile.ts';

/** The name of the format, as an answer in it says. */
export const RESPONSES_API = 'openai-responses';

function refuse(profile: ResponsesProfile, message: string): never {
  throw new ModelFailure(message, 'invalid_request', { provider: profile.id });
}

export function buildBody(step: ModelStep, profile: ResponsesProfile): JsonObject {
  const input = step.messages.flatMap((message, index) =>
    items(message, `messages[${String(index)}]`, profile),
  );
  const tools = [
    ...step.tools.map((tool) => ({
      ...tool.providerOptions,
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // A `strict` left out stays out: the provider reads that as other than false.
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    })),
    ...profile.hostedTools(step.options ?? {}),
  ];
  const instructions = step.instructions === '' ? undefined : step.instructions;
  const inInput = profile.instructionsInInput && instructions !== undefined;
  const first = {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: instructions ?? '' }],
  };
  return {
    ...profile.options(step),
    ...(profile.streams ? { stream: true } : {}),
    model: step.model,
    ...(instructions === undefined || inInput ? {} : { instructions }),
    input: inInput ? [first, ...input] : input,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function items(message: Message, where: string, profile: ResponsesProfile): JsonObject[] {
  switch (message.role) {
    case 'user':
      return [{ type: 'message', role: 'user', content: parts(message.content, where, profile) }];
    case 'system':
      return [
        {
          ...message.providerOptions,
          type: 'message',
          role: profile.systemRole,
          content: parts(message.content, where, profile),
        },
      ];
    case 'assistant':
      if (message.provider !== profile.id || message.api !== RESPONSES_API) {
        return refuse(
          profile,
          `${where} is an answer of ${message.provider}, which ${profile.label} cannot be sent`,
        );
      }
      return message.content.map((item) => omit(item, profile.outputOnlyFields));
    case 'native':
      if (message.provider !== profile.id) {
        return refuse(
          profile,
          `${where} holds items of ${message.provider}, which ${profile.label} cannot take`,
        );
      }
      return message.content;
    case 'tool_result':
      return [toolResult(message, where, profile)];
    case 'custom':
      // The application's own: no provider is sent it.
      return [];
  }
}

function toolResult(
  message: ToolResultMessage,
  where: string,
  profile: ResponsesProfile,
): JsonObject {
  const custom = message.toolType === 'custom';
  return {
    ...message.providerOptions,
    type: custom ? 'custom_tool_call_output' : 'function_call_output',
    call_id: message.toolCallId,
    output: plainText(message.content) ?? parts(message.content, where, profile),
  };
}

/** The text of content that is one piece of text and nothing else, which is sent as it is. */
function plainText(content: readonly ContentPart[]): string | undefined {
  if (content.length === 0) return '';
  const [only] = content;
  if (content.length !== 1 || only?.type !== 'text' || only.providerOptions !== undefined)
    return undefined;
  return only.text;
}

function parts(
  content: readonly ContentPart[],
  where: string,
  profile: ResponsesProfile,
): JsonObject[] {
  return content.map((part, index) => {
    const at = `${where}.content[${String(index)}]`;
    switch (part.type) {
      case 'text':
        return { ...part.providerOptions, type: 'input_text', text: part.text };
      case 'image': {
        const { source } = part;
        if (source.type === 'file_id' && !profile.fileIds) {
          return refuse(
            profile,
            `${at} is an image by its file ID, which ${profile.label} cannot take`,
          );
        }
        return {
          ...part.providerOptions,
          type: 'input_image',
          ...(source.type === 'url'
            ? { image_url: source.url }
            : source.type === 'base64'
              ? { image_url: `data:${source.mediaType};base64,${source.data}` }
              : { file_id: source.id }),
        };
      }
      case 'file': {
        if (!profile.files) {
          return refuse(
            profile,
            `${at} is a file, which ${profile.label} would drop without a word`,
          );
        }
        const { source } = part;
        return {
          ...part.providerOptions,
          type: 'input_file',
          ...(source.type === 'url'
            ? { file_url: source.url }
            : source.type === 'base64'
              ? { file_data: `data:${source.mediaType};base64,${source.data}` }
              : { file_id: source.id }),
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        };
      }
    }
  });
}
