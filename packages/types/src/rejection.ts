// A structured refusal returned by init or step.
//
// Rejecting is ordinary behavior, not a crash: it is a returned value, and
// a thrown error is a bug. A rejection means nothing happened. The state
// stays as it was, nothing is appended, and the runner tells whoever sent
// the request that it was refused, with `error` as the reason.

import type { Json } from './json.js';

export type Rejection = {
  /** Why the request was refused. Passed to the caller as is. */
  error: Json;
};
