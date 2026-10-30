// The tools the agent offers the model. An agent adds its own here, each
// with its handler in handlers.ts. Keep their order stable: what the model
// sees first should change least, for prompt caching.

import type { AnyTool } from './define.js';

export const TOOLS: readonly AnyTool[] = [];
