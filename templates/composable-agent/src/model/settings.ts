// The model part's settings: its config with the defaults filled in.

import type { ModelRef } from '../core/model.js';
import type { ModelConfig, Thinking } from './config.js';

export type ModelSettings = {
  model: ModelRef;
  thinking: Thinking;
};

export const DEFAULT_MODEL: ModelRef = { provider: 'anthropic', id: 'claude-sonnet-5-5' };
export const DEFAULT_THINKING: Thinking = 'medium';

export function modelSettings(config: ModelConfig): ModelSettings {
  return {
    model: config.model ?? DEFAULT_MODEL,
    thinking: config.thinking ?? DEFAULT_THINKING,
  };
}
