// What is known about each model: its limits, what it takes as input and its
// prices. A model need not be here to be used; one that is gets cost
// estimates, and a step can read its context window.

import { ANTHROPIC_MODELS } from './catalog/anthropic.js';
import { FIREWORKS_MODELS } from './catalog/fireworks.js';
import { OPENAI_MODELS } from './catalog/openai.js';
import type { ModelInfo } from './model.js';
import type { Provider } from './providers.js';

/** Every model, by provider. */
export const MODELS: { readonly [P in Provider]: readonly ModelInfo<P>[] } = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  fireworks: FIREWORKS_MODELS,
};

/** The model, or undefined for one not listed, which still works. */
export function findModel<P extends Provider>(provider: P, id: string): ModelInfo<P> | undefined {
  const models: readonly ModelInfo[] = MODELS[provider];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return models.find((model) => model.id === id) as ModelInfo<P> | undefined;
}
