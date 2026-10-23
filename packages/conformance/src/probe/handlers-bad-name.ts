// A handlers module a runner must refuse: it names a handler with `@`,
// which belongs to runners' built-in kinds.

import type { HandlerDef } from '@acentric/types';

const handlers: Record<string, HandlerDef> = {
  '@timer': { mode: 'reissue', run: () => Promise.resolve(null) },
};

export default handlers;
