// Calls model providers: the interface a provider implements, the codecs of the wire formats
// providers share, and the providers themselves.

export * from './runner.ts';
export * from './failure.ts';
export * from './provider.ts';
export * from './catalog.ts';
export { openai, chatgpt, OPENAI_MODELS } from './providers/openai.ts';
export { chatGptSignIn } from './providers/chatgpt-sign-in.ts';
export { fireworks, FIREWORKS_MODELS } from './providers/fireworks.ts';
export {
  anthropic,
  anthropicAt,
  ANTHROPIC_API_URL,
  ANTHROPIC_MODELS,
} from './providers/anthropic.ts';

import { anthropic, anthropicAt } from './providers/anthropic.ts';
import { fireworks } from './providers/fireworks.ts';
import { chatgpt, openai } from './providers/openai.ts';
import { Providers } from './provider.ts';

/**
 * The providers there are, for an engine that names no others. `anthropicUrl` is where
 * Anthropic's API is taken to be, for tests: its own without it.
 */
export function builtInProviders(options: { anthropicUrl?: string } = {}): Providers {
  const atAnthropic =
    options.anthropicUrl === undefined ? anthropic : anthropicAt(options.anthropicUrl);
  return new Providers([openai, chatgpt, fireworks, atAnthropic]);
}
