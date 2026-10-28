// The retry part's config: how failed model calls are tried again.

import { Type } from 'typebox';
import type { Static } from 'typebox';

export const RetryConfig = Type.Object({
  /** Retry a failed model call that may succeed later, waiting longer each time. */
  retry: Type.Optional(
    Type.Object(
      {
        maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
        baseDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
        maxDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
  ),
});
export type RetryConfig = Static<typeof RetryConfig>;
