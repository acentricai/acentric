// Converting between the agent's messages and pi-ai's, at the handler
// boundary. The agent keeps the fields it needs, including the signatures
// providers check when earlier replies are sent back.

import type {
  AssistantMessage as PiAssistantMessage,
  ImageContent,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage as PiUsage,
} from '@earendil-works/pi-ai';

import type {
  AssistantMessage,
  ImageBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  Usage,
} from '../content.js';
import type { ContextMessage } from '../context.js';
import { isJson, isObject } from '../guards.js';

export function fromPiUsage(usage: PiUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
}

function toPiUsage(usage: Usage): PiUsage {
  const { cost, ...tokens } = usage;
  return { ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

export function fromPiAssistant(message: PiAssistantMessage): AssistantMessage {
  // pi-ai ends every call it returns with one of the agent's stop reasons;
  // 'pending' and 'deferred' only appear mid-stream or for deferred calls.
  const stopReason =
    message.stopReason === 'pending' || message.stopReason === 'deferred'
      ? 'error'
      : message.stopReason;
  return {
    content: message.content.map(fromPiBlock),
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: fromPiUsage(message.usage),
    stopReason,
    ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
  };
}

function fromPiBlock(
  block: TextContent | ThinkingContent | ToolCall,
): TextBlock | ThinkingBlock | ToolCallBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case 'toolCall': {
      // pi-ai's Json allows undefined values, which the log cannot hold.
      const args: unknown = block.arguments;
      const valid = isJson(args) && isObject(args);
      const argumentsError = valid ? block.argumentsError : 'the arguments are not plain Json';
      return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: valid ? args : {},
        ...(argumentsError === undefined ? {} : { argumentsError }),
        ...(block.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: block.thoughtSignature }),
      };
    }
  }
}

/** The agent's context as pi-ai messages. Times are not kept, so they are 0. */
export function toPiMessages(context: readonly ContextMessage[]): PiMessage[] {
  return context.map((message): PiMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content.map(toPiContent), timestamp: 0 };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content.map(toPiAssistantBlock),
          api: message.api,
          provider: message.provider,
          model: message.model,
          usage: toPiUsage(message.usage),
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          timestamp: 0,
        };
      case 'toolResult':
        return {
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content.map(toPiContent),
          ...(message.details === undefined ? {} : { details: message.details }),
          isError: message.isError,
          timestamp: 0,
        };
    }
  });
}

function toPiContent(block: TextBlock | ImageBlock): TextContent | ImageContent {
  return block.type === 'text'
    ? toPiText(block)
    : { type: 'image', data: block.data, mimeType: block.mimeType };
}

function toPiText(block: TextBlock): TextContent {
  return {
    type: 'text',
    text: block.text,
    ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
  };
}

function toPiAssistantBlock(
  block: TextBlock | ThinkingBlock | ToolCallBlock,
): TextContent | ThinkingContent | ToolCall {
  switch (block.type) {
    case 'text':
      return toPiText(block);
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: block.thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case 'toolCall':
      return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.arguments,
        ...(block.argumentsError === undefined ? {} : { argumentsError: block.argumentsError }),
        ...(block.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: block.thoughtSignature }),
      };
  }
}
