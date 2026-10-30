// A request to any model in @acentric/llm. The conversation is converted to
// the model's provider each time: replies from another model, before a
// config change, cannot be sent back as they are.

import { convert } from '@acentric/llm';
import type { LlmRequest, Message, Provider, ProviderOptions, ToolDefinition } from '@acentric/llm';

import type { ModelRef } from './model.js';

/** Provider options, by provider: the one for the model's provider is sent. */
export type OptionsByProvider = { readonly [P in Provider]?: ProviderOptions<P> };

export type RequestParts = {
  readonly instructions: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly options?: OptionsByProvider;
};

export function requestFor(model: ModelRef, parts: RequestParts): LlmRequest {
  const tools = parts.tools === undefined || parts.tools.length === 0 ? {} : { tools: parts.tools };
  switch (model.provider) {
    case 'anthropic': {
      const options = parts.options?.anthropic;
      return {
        provider: 'anthropic',
        model: model.id,
        instructions: parts.instructions,
        messages: convert(parts.messages, { provider: 'anthropic', model: model.id }).messages,
        ...tools,
        ...(options === undefined ? {} : { options }),
      };
    }
    case 'openai': {
      const options = parts.options?.openai;
      return {
        provider: 'openai',
        model: model.id,
        instructions: parts.instructions,
        messages: convert(parts.messages, { provider: 'openai', model: model.id }).messages,
        ...tools,
        ...(options === undefined ? {} : { options }),
      };
    }
    case 'fireworks': {
      const options = parts.options?.fireworks;
      return {
        provider: 'fireworks',
        model: model.id,
        instructions: parts.instructions,
        messages: convert(parts.messages, { provider: 'fireworks', model: model.id }).messages,
        ...tools,
        ...(options === undefined ? {} : { options }),
      };
    }
  }
}
