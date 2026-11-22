// The body of a request to Anthropic's Messages API, from a step. Each message of the
// conversation becomes one message of Anthropic's.

import type {
  ContentPart,
  JsonObject,
  MediaSource,
  Message,
  ProviderFields,
} from '@acentric/protocol';

import type { ModelInfo } from '../catalog.ts';
import { ModelFailure } from '../failure.ts';
import { effortOf } from '../provider.ts';
import type { WebSearch } from '../provider.ts';
import type { ModelStep } from '../runner.ts';

export const PROVIDER = 'anthropic';
export const LABEL = 'Anthropic';
/** The name of the format, as an answer in it says. */
export const MESSAGES_API = 'anthropic-messages';

/** The most a model writes when nothing is known of it: what the Claude 5 models write. */
const DEFAULT_MAX_TOKENS = 128_000;

/** Anthropic's web search, in the version sent. */
const WEB_SEARCH = 'web_search_20260318';

/** Every level is sent as itself. */
const LEVELS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

/** What is kept of what Anthropic has read, to be read again at a lower price. */
const CACHED = { cache_control: { type: 'ephemeral' } };

/** The beta of a reasoning effort set by a system message, from that message on. */
export const MESSAGE_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';

/** The betas a request has to name for what is in it, for the `anthropic-beta` header. */
export function betasOf(body: JsonObject): string[] {
  const messages = body['messages'] as readonly JsonObject[];
  const effortInMessages = messages.some(
    (message) => message['role'] === 'system' && message['output_config'] !== undefined,
  );
  return effortInMessages ? [MESSAGE_EFFORT_BETA] : [];
}

function refuse(message: string): never {
  throw new ModelFailure(message, 'invalid_request', { provider: PROVIDER });
}

export function buildBody(step: ModelStep, models: readonly ModelInfo[]): JsonObject {
  const messages = step.messages.flatMap((message, index) =>
    messageOf(message, `messages[${String(index)}]`, step.model),
  );
  const tools = [
    ...step.tools.map((tool) => ({
      ...tool.providerOptions,
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    })),
    ...hostedTools(step.options ?? {}),
  ];
  return {
    // The model thinks as much as the step needs, and gives its thinking summed up in words:
    // by itself it would give nothing of it.
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: effortOf(LEVELS, step.reasoning) },
    // One mark on the last block that can be kept, moved along by each call.
    ...CACHED,
    // Asked for as a stream and read whole: a long answer keeps the connection busy, and is
    // given up when it goes quiet, not when it is long.
    stream: true,
    model: step.model,
    max_tokens:
      models.find((model) => model.id === step.model)?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    // The instructions have a mark of their own: they and the tools stay kept when the start
    // of the conversation changes, and the actors of an agent share them.
    ...(step.instructions === ''
      ? {}
      : { system: [{ type: 'text', text: step.instructions, ...CACHED }] }),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function hostedTools(asked: ProviderFields): JsonObject[] {
  const search = asked['webSearch'] as WebSearch | undefined;
  if (search === undefined) return [];
  const domains =
    search === true
      ? {}
      : 'allowedDomains' in search
        ? { allowed_domains: [...search.allowedDomains] }
        : { blocked_domains: [...search.blockedDomains] };
  // What it finds goes to the model as it is, not through code the model writes to sift it.
  return [{ type: WEB_SEARCH, name: 'web_search', allowed_callers: ['direct'], ...domains }];
}

function messageOf(message: Message, where: string, model: string): JsonObject[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: parts(message.content, where) }];
    case 'system':
      return [
        { ...message.providerOptions, role: 'system', content: parts(message.content, where) },
      ];
    case 'assistant': {
      if (message.provider !== PROVIDER || message.api !== MESSAGES_API) {
        return refuse(
          `${where} is an answer of ${message.provider}, which ${LABEL} cannot be sent`,
        );
      }
      if (message.model === model) {
        // An answer that was thinking and nothing else, with its thinking left out, is nothing.
        return message.content.length > 0 ? [{ role: 'assistant', content: message.content }] : [];
      }
      // Another model's thinking is its own: some models read it, others pass over it without
      // a word. The rest of what it wrote is sent as it was written.
      const kept = message.content.filter(
        (block) => block['type'] !== 'thinking' && block['type'] !== 'redacted_thinking',
      );
      return kept.length > 0 ? [{ role: 'assistant', content: kept }] : [];
    }
    case 'native':
      if (message.provider !== PROVIDER) {
        return refuse(`${where} holds items of ${message.provider}, which ${LABEL} cannot take`);
      }
      return [{ role: 'user', content: message.content }];
    case 'tool_result': {
      if (message.toolType === 'custom')
        return refuse(`${where} answers a custom tool, and ${LABEL} has none`);
      const [only] = message.content;
      // One piece of text and nothing else is sent as it is. Anything else is sent as its parts.
      const plain =
        message.content.length === 1 && only?.type === 'text' && only.providerOptions === undefined
          ? only.text
          : undefined;
      return [
        {
          role: 'user',
          content: [
            {
              ...message.providerOptions,
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: plain ?? parts(message.content, where),
              ...(message.isError === undefined ? {} : { is_error: message.isError }),
            },
          ],
        },
      ];
    }
    case 'custom':
      // The application's own: no provider is sent it.
      return [];
  }
}

function parts(content: readonly ContentPart[], where: string): JsonObject[] {
  return content.map((part, index) => {
    const at = `${where}.content[${String(index)}]`;
    switch (part.type) {
      case 'text':
        return { ...part.providerOptions, type: 'text', text: part.text };
      case 'image':
        return { ...part.providerOptions, type: 'image', source: sourceOf(part.source, at, false) };
      case 'file':
        return {
          ...part.providerOptions,
          type: 'document',
          source: sourceOf(part.source, at, true),
          ...(part.filename === undefined ? {} : { title: part.filename }),
        };
    }
  });
}

/** A source as Anthropic takes it. A document of plain text goes as text, the only way it is taken. */
function sourceOf(source: MediaSource, at: string, document: boolean): JsonObject {
  if (source.type === 'url') return { type: 'url', url: source.url };
  if (source.type === 'file_id') return { type: 'file', file_id: source.id };
  if (document && source.mediaType === 'text/plain') {
    try {
      const bytes = Uint8Array.from(atob(source.data), (char) => char.codePointAt(0) ?? 0);
      return {
        type: 'text',
        media_type: 'text/plain',
        data: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      };
    } catch {
      return refuse(`${at} is said to be plain text, and is not UTF-8 text in base64`);
    }
  }
  return { type: 'base64', media_type: source.mediaType, data: source.data };
}
