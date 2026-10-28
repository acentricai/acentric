// The compaction part's config: when older history is summarised, and by
// which model.

import { Type } from 'typebox';
import type { Static } from 'typebox';

import { ModelRef } from '../core/model.js';

export const CompactionConfig = Type.Object({
  /** The model that writes compaction summaries. Defaults to the model that answers. */
  summaryModel: Type.Optional(ModelRef),
  /** Summarise older history once the context passes `triggerTokens`, keeping the newest `keepTokens`. */
  compaction: Type.Optional(
    Type.Object(
      {
        triggerTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        keepTokens: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  ),
});
export type CompactionConfig = Static<typeof CompactionConfig>;
