// The loop's effect: the model call. Its args combine several parts (the
// model, what compaction leaves for it to read, the prompt, the tools), so
// they are defined here, where the parts are put together.

import type { LlmResponse } from '@acentric/llm';

import type { ContextRefs } from '../compaction/index.js';
import type { ModelRef } from '../core/model.js';
import type { Thinking } from '../model/index.js';
import type { PromptArgs } from '../prompt/index.js';

/**
 * A model call. It points at the log rather than copy the conversation: the
 * handler reads the entries `context` names and builds the request from
 * them, the instructions `prompt` gives, and the tools named in `tools`.
 */
export type LlmArgs = {
  model: ModelRef;
  thinking: Thinking;
  context: ContextRefs;
  prompt: PromptArgs;
  /** The tools offered this call, by name. */
  tools: string[];
};

export type LoopKinds = {
  /** Calls the model. Reissue. */
  llm: { args: LlmArgs; result: LlmResponse };
};
