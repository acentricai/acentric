// The composable agent's handlers: its I/O, kept apart from the pure half.
// The kinds they serve, and their args and results, are in types/kinds.ts.
// An agent's tools are added to toolHandlers, each made with toolHandler
// (tools/handler.ts).
//
// Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY or FIREWORKS_API_KEY for the
// models used, or the gateway's ACENTRIC_LLM_URL and ACENTRIC_LLM_TOKEN.

import type { HandlersFor } from '@acentric/types';

import { summarizeHandler } from './compaction/handler.js';
import { llmHandler } from './loop/handler.js';
import { toolHandlers } from './tools/handler.js';
import type { Kinds } from './types/kinds.js';

const handlers: HandlersFor<Kinds> = {
  llm: llmHandler(),
  summarize: summarizeHandler(),
  ...toolHandlers(),
};

export default handlers;
