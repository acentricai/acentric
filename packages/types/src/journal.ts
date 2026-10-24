// Layer 1: the journal. What a session received, for replaying it.
//
// A runner MAY keep one. Each entry records one thing that changed, or could
// have changed, a session's state, in the same save as the change: its
// creation, a message delivered to step, or an upgrade's migrate. Replaying
// the entries in order, each at its `now` and on its version's code, gives
// the same states and log, since step is pure and every input it has is in
// the journal.
//
// A digest says what each change left, so a replay can tell where code
// first differs without the runner keeping old snapshots: SHA-256, as
// lowercase hex, of the RFC 8785 canonical JSON of
// `[snapshot, config, appended]`, `appended` being the entries the change
// added as `{ kind, body }`.

import type { JsonObject } from './json.js';
import type { Message } from './message.js';

/** How step answered a message: rejected and failed steps change nothing. */
export type JournalAnswer = 'accepted' | 'rejected' | 'failed';

/** One entry of a session's journal. `n` counts 1, 2, 3... per session, with no gaps. */
export type JournalEntry =
  | {
      readonly n: number;
      readonly type: 'init';
      /** The agent version that ran init. */
      readonly version: string;
      readonly now: number;
      readonly config: JsonObject;
      readonly digest: string;
    }
  | {
      readonly n: number;
      readonly type: 'step';
      /** The agent version whose step received the message. */
      readonly version: string;
      readonly now: number;
      readonly message: Message;
      readonly answer: JournalAnswer;
      /** Present when the step was accepted. */
      readonly digest?: string;
    }
  | {
      readonly n: number;
      readonly type: 'upgrade';
      /** The version the session moved to, whose migrate ran. */
      readonly version: string;
      /** The version it moved from. */
      readonly from: string;
      readonly now: number;
      readonly digest: string;
    };
