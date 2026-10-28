// The model part's config: which model answers, and how hard it thinks.

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { ModelRef } from '../core/model.js';

/**
 * How hard the model thinks, by name. The model call turns a level into
 * each provider's own options. An agent narrows these to the levels it
 * offers.
 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;
export const Thinking = Type.Enum(THINKING_LEVELS);
export type Thinking = Static<typeof Thinking>;

export const ModelConfig = Type.Object({
  /** The model that reads messages and calls tools. */
  model: Type.Optional(ModelRef),
  thinking: Type.Optional(Thinking),
});
export type ModelConfig = Static<typeof ModelConfig>;
