// Calls model providers: the interface a provider implements, the codecs of the wire formats
// providers share, and the providers themselves.

export * from './runner.ts';
export * from './failure.ts';
export * from './provider.ts';
export * from './catalog.ts';
export { openai, chatgpt, OPENAI_MODELS } from './providers/openai.ts';
export { fireworks, FIREWORKS_MODELS } from './providers/fireworks.ts';
export { anthropic, ANTHROPIC_MODELS } from './providers/anthropic.ts';

import { anthropic } from './providers/anthropic.ts';
import { fireworks } from './providers/fireworks.ts';
import { chatgpt, openai } from './providers/openai.ts';
import { Providers } from './provider.ts';

/** The providers there are, for an engine that names no others. */
export function builtInProviders(): Providers {
  return new Providers([openai, chatgpt, fireworks, anthropic]);
}
