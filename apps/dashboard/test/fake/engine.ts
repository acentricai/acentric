// The fake server's routes of the dashboard's engine area.

import type { Area, Call, Shared } from './area.ts';

export function engineArea(_shared: Shared) {
  return {
    answer: (_call: Call): Response | undefined => undefined,
  } satisfies Area;
}
