// The pi agent's handlers: the impure half. Kept apart from the pure half,
// so loading the agent's decisions never loads Node or network code.

import type { Agent, HandlersFor } from '@acentric/types';
import type { Models } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import { piAgent } from '../agent.js';
import type { PiConfig } from '../config.js';
import type { PiKinds } from '../kinds.js';
import type { PiSnapshot } from '../snapshot.js';
import { llmHandler, summarizeHandler } from './llm.js';
import { toolHandler } from './tools.js';

export type HandlerOptions = {
  /** The models to call, with pi-ai's built-in providers by default. */
  models?: Models;
};

export function createHandlers(options: HandlerOptions = {}): HandlersFor<PiKinds> {
  const models = options.models ?? builtinModels();
  return {
    llm: llmHandler(models),
    summarize: summarizeHandler(models),
    read: toolHandler('read'),
    bash: toolHandler('bash'),
    edit: toolHandler('edit'),
    write: toolHandler('write'),
  };
}

/** The pi agent with its handlers, ready for a runner. */
export function createPiAgent(options: HandlerOptions = {}): Agent<PiSnapshot, PiConfig, PiKinds> {
  return { ...piAgent, handlers: createHandlers(options) };
}

export { apiKeySecret } from './keys.js';
export { fromPiAssistant, toPiMessages } from './convert.js';
