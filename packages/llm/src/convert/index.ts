// Moving a conversation to another provider or model. Pure.
//
// Assistant and native messages are the only ones that belong to a provider.
// An assistant message from the target's own provider and model is kept as it
// is. One from another provider or model in the same API format is filtered.
// Any other is read into a common form and written in the target's format.
// Shared messages keep their shape, less what the target cannot take.

import type { JsonObject } from '@acentric/types';

import type { ContentPart } from '../content.js';
import type { ProviderFields } from '../fields.js';
import type { AssistantMessage, Message, ToolResultMessage } from '../messages.js';
import type { ApiFormat, Provider } from '../providers.js';
import { anthropicConverter } from './anthropic.js';
import { responsesConverter } from './responses.js';
import type {
  Capabilities,
  Context,
  Conversion,
  ConversionChange,
  ConvertOptions,
  ConvertTarget,
  FormatConverter,
  Target,
} from './types.js';

export type { Conversion, ConversionChange, ConvertOptions, ConvertTarget } from './types.js';

/** What each provider takes. A new provider fails to compile until it is here. */
const CAPABILITIES: { readonly [P in Provider]: Capabilities } = {
  anthropic: {
    api: 'anthropic-messages',
    customTools: false,
    files: true,
    fileIds: true,
    plainReasoning: false,
  },
  // OpenAI takes reasoning items with only text, and ignores them.
  openai: {
    api: 'openai-responses',
    customTools: true,
    files: true,
    fileIds: true,
    plainReasoning: false,
  },
  // Fireworks drops file parts without an error, has no file storage, and
  // takes custom tools its models never call.
  fireworks: {
    api: 'openai-responses',
    customTools: false,
    files: false,
    fileIds: false,
    plainReasoning: true,
  },
};

/**
 * The fields each provider reads in `providerOptions` on shared parts and tool
 * results. A field other providers own and the target does not is dropped;
 * one nobody owns is kept. Nothing is translated: where cache breakpoints go
 * is a choice for each request, and providers place and limit them differently.
 */
const PART_OPTIONS: { readonly [P in Provider]: readonly string[] } = {
  anthropic: ['cache_control', 'citations', 'context', 'title', 'transformations', 'toolset_name'],
  openai: ['detail', 'prompt_cache_breakpoint', 'caller', 'namespace'],
  fireworks: ['detail'],
};

const FORMATS: { readonly [A in ApiFormat]: FormatConverter } = {
  'openai-responses': responsesConverter,
  'anthropic-messages': anthropicConverter,
};

/** The IDs Anthropic takes for tool calls. Other formats take any string. */
const ANTHROPIC_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * The conversation, ready to send to `to.provider` and `to.model`, with every
 * change made to get it. Messages that already fit the target come back
 * unchanged, and the application's `custom` messages are kept. Conversion
 * loses things, so keep the original and convert it each time.
 */
export function convert<P extends Provider>(
  messages: readonly Message[],
  to: ConvertTarget<P>,
  options: ConvertOptions = {},
): Conversion<Message<P>> {
  const target: Target = { ...CAPABILITIES[to.provider], provider: to.provider, model: to.model };
  const changes: ConversionChange[] = [];
  const rewritten = new Set<string>();
  let index = 0;
  const context: Context = {
    target,
    reasoning: options.reasoning ?? 'drop',
    droppedCalls: new Set(),
    change(action, what, detail) {
      changes.push({ index, action, what, detail });
    },
    callId(id) {
      if (target.api !== 'anthropic-messages' || ANTHROPIC_CALL_ID.test(id)) return id;
      const mapped = `${id.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}_${hash(id)}`;
      // Reported once, where the call is: its result follows the same mapping.
      if (!rewritten.has(id)) context.change('rewritten', 'tool_call_id', `${id} → ${mapped}`);
      rewritten.add(id);
      return mapped;
    },
  };
  const foreign = foreignOptions(to.provider);

  const out: Message[] = [];
  for (const [at, message] of messages.entries()) {
    index = at;
    const converted = convertMessage(message, context, foreign);
    if (converted !== undefined) out.push(converted);
  }
  return { messages: forProvider<P>(out), changes };
}

function convertMessage(
  message: Message,
  context: Context,
  foreign: ReadonlySet<string>,
): Message | undefined {
  switch (message.role) {
    case 'custom':
      return message;
    case 'assistant':
      return convertAssistant(message, context);
    case 'native':
      if (message.provider === context.target.provider) return message;
      context.change('dropped', 'message', `${message.provider} native items`);
      return undefined;
    case 'tool_result':
      return convertToolResult(message, context, foreign);
    case 'user': {
      const content = parts(message.content, context, foreign);
      if (content.length > 0) return { ...message, content };
      context.change('dropped', 'message', 'user message left empty');
      return undefined;
    }
    case 'system': {
      const content = parts(message.content, context, foreign);
      if (content.length > 0) return { ...message, content };
      context.change('dropped', 'message', 'system message left empty');
      return undefined;
    }
  }
}

function convertAssistant(message: AssistantMessage, context: Context): Message | undefined {
  const { target } = context;
  const sameProvider = message.provider === target.provider;
  if (sameProvider && message.model === target.model) return message;

  const items: readonly JsonObject[] = message.content;
  const content =
    message.api === target.api
      ? FORMATS[message.api].sameFormat(items, sameProvider, context)
      : FORMATS[target.api].write(FORMATS[message.api].read(items, context), context);
  if (content.length === 0) {
    context.change('dropped', 'message', 'assistant message left empty');
    return undefined;
  }
  // A response ID belongs to the provider that answered.
  const { id, ...rest } = message;
  return assistant({
    ...rest,
    ...(sameProvider && id !== undefined ? { id } : {}),
    provider: target.provider,
    api: target.api,
    model: target.model,
    content,
  });
}

function convertToolResult(
  message: ToolResultMessage,
  context: Context,
  foreign: ReadonlySet<string>,
): Message | undefined {
  if (context.droppedCalls.has(message.toolCallId)) {
    context.change('dropped', 'tool_result', `answers dropped call ${message.toolCallId}`);
    return undefined;
  }
  const { providerOptions, ...rest } = message;
  const fields = keptOptions(providerOptions, context, foreign);
  return {
    ...rest,
    toolCallId: context.callId(message.toolCallId),
    content: parts(message.content, context, foreign),
    ...(fields === undefined ? {} : { providerOptions: fields }),
  };
}

function parts<T extends ContentPart>(
  content: readonly T[],
  context: Context,
  foreign: ReadonlySet<string>,
): T[] {
  const { target } = context;
  return content.flatMap((part): T[] => {
    if (part.type === 'file' && !target.files) {
      context.change('dropped', 'part', `file part: ${target.provider} takes no files`);
      return [];
    }
    if (part.type !== 'text' && part.source.type === 'file_id' && !target.fileIds) {
      context.change('dropped', 'part', `${part.type} by file ID: ${target.provider} takes none`);
      return [];
    }
    if (part.providerOptions === undefined) return [part];
    const fields = keptOptions(part.providerOptions, context, foreign);
    return [fields === undefined ? withoutOptions(part) : { ...part, providerOptions: fields }];
  });
}

function withoutOptions<T extends ContentPart>(part: T): T {
  const { providerOptions: _providerOptions, ...rest } = part;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return rest as T;
}

/** `providerOptions` without other providers' fields, or undefined when none are left. */
function keptOptions(
  value: ProviderFields | undefined,
  context: Context,
  foreign: ReadonlySet<string>,
): ProviderFields | undefined {
  if (value === undefined) return undefined;
  const kept = Object.fromEntries(
    Object.entries(value).filter(([key]) => {
      if (!foreign.has(key)) return true;
      context.change('dropped', 'part_option', key);
      return false;
    }),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Fields other providers own that `provider` does not. */
function foreignOptions(provider: Provider): ReadonlySet<string> {
  const own = new Set(PART_OPTIONS[provider]);
  return new Set(
    Object.entries(PART_OPTIONS)
      .filter(([other]) => other !== provider)
      .flatMap(([, keys]) => keys)
      .filter((key) => !own.has(key)),
  );
}

/** A converted assistant message: its items are the target format's, written above. */
function assistant(
  message: Omit<AssistantMessage, 'content'> & {
    readonly content: readonly JsonObject[];
  },
): Message {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return message as AssistantMessage;
}

/** The converted messages, every one now for provider `P`. */
function forProvider<P extends Provider>(messages: Message[]): Message<P>[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return messages as Message<P>[];
}

/** FNV-1a in base 36: a short, stable suffix that keeps rewritten IDs apart. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}
