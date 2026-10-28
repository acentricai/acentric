// The model part's log entries. Never sent to the model.

import type { LlmFailure } from '@acentric/llm';

export type ModelEntries = {
  /** A model call that failed, and whether it will be tried again. */
  model_error: { failure: LlmFailure | null; text: string; retrying: boolean };
};
