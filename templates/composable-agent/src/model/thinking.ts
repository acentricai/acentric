// What a thinking level asks of each provider. Anthropic's models think
// adaptively at an effort; OpenAI's and Fireworks' take a reasoning effort.
// A model that does not take a level, such as one that cannot stop
// thinking, refuses the request, and the call fails as invalid.

import type { OptionsByProvider } from '../core/request.js';
import type { Thinking } from './config.js';

export function thinkingOptions(thinking: Thinking): OptionsByProvider {
  if (thinking === 'off') {
    return {
      anthropic: { thinking: { type: 'disabled' } },
      openai: { reasoning: { effort: 'none' } },
      fireworks: { reasoning: { effort: 'none' } },
    };
  }
  return {
    anthropic: { thinking: { type: 'adaptive' }, output_config: { effort: thinking } },
    openai: { reasoning: { effort: thinking } },
    fireworks: { reasoning: { effort: thinking } },
  };
}
