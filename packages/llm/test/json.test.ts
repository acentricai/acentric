// Every shape a handler returns, a step stores or a log holds must be the
// framework's Json. These lines fail to compile if one is not.

import type { HandlerDef, Json, JsonObject, LogAppend } from '@acentric/types';
import { describe, expect, it } from 'vitest';

import type {
  AssistantMessage,
  ConversionChange,
  LlmFailure,
  LlmRequest,
  LlmResponse,
  Message,
  ModelInfo,
  NativeMessage,
  ToolCall,
  ToolDefinition,
  Usage,
} from '../src/index.js';

type IsJson<T extends Json> = T;

export type Checked = [
  IsJson<LlmResponse>,
  IsJson<LlmResponse<'anthropic'>>,
  IsJson<LlmRequest>,
  IsJson<LlmRequest<'fireworks'>>,
  IsJson<Message>,
  IsJson<AssistantMessage<'openai'>>,
  IsJson<NativeMessage<'openai'>>,
  IsJson<ToolCall>,
  IsJson<ToolDefinition>,
  IsJson<Usage>,
  IsJson<LlmFailure>,
  IsJson<ConversionChange>,
  IsJson<ModelInfo>,
];

/** A handler that returns a response, and the args it takes, as an agent declares them. */
export const handler: HandlerDef<
  { readonly request: LlmRequest<'openai'> & JsonObject },
  LlmResponse<'openai'>
> = {
  mode: 'reissue',
  run: () => Promise.reject(new Error('not called')),
};

/** A message logged as it is. */
export function logged(message: Message): LogAppend {
  return { kind: 'message', body: message };
}

describe('the types', () => {
  it('are Json, which the lines above check when they compile', () => {
    expect(logged({ role: 'custom', tag: 'x', data: null }).kind).toBe('message');
  });
});
