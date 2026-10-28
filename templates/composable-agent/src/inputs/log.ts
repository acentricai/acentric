// The inputs part's log entries. Never sent to the model.

import type { UserMessage } from '@acentric/llm';

export type InputsEntries = {
  /** A message that arrived during a turn. Appended again as `user` when its turn comes. */
  queued: UserMessage;
};
