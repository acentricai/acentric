// What a model call sends. Its args point at the log rather than copy it:
// the conversation is already there.

import type { ModelRef } from '../core/model.js';
import type { Thinking } from './config.js';

/**
 * A model call: its model, and the conversation entries it reads, those
 * with fromSeq <= seq < toSeq. How a compaction summary comes before them
 * is the compaction part's, settled with its contract.
 */
export type ModelCallArgs = {
  model: ModelRef;
  thinking: Thinking;
  fromSeq: number;
  toSeq: number;
};
