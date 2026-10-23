// Layer 2: migrate. Moves an existing agent session onto a new version of
// the agent's code.
//
// When and whether sessions are upgraded is the runner's policy. The
// framework defines only the agent's part. At a step boundary the runner
// calls the new version's migrate with the session's stored snapshot and
// config, saves what it returns, and then delivers a `migrated` message to
// the new version's step. From then on the new version's step, effects and
// handlers are used.
//
// Only the snapshot and config can be converted. The log is history and
// stays as it was, so new code that reads old entries must accept their
// old shapes. Results of effects the old version started may still arrive,
// and the new step must accept those too.
//
// Upgrades are requested by trusted callers, so migrate may change config,
// which a step never can.
//
// If it fails the way a step can, by throwing, returning something that is
// not Json or going over a runner limit, the upgrade does not happen and the
// session stays on its old version, as with a rejection.

import type { JsonObject } from './json.js';
import type { Rejection } from './rejection.js';

/**
 * What migrate returns: the converted state, or a rejection. On a rejection
 * the session stays on its old version and no `migrated` message is sent.
 */
export type MigrateResult<S extends JsonObject, C extends JsonObject> =
  | {
      /** The snapshot in this version's shape. */
      snapshot: S;
      /**
       * The config in this version's shape. Left out, the stored config is
       * kept as it is, so leave it out only when its shape did not change.
       */
      config?: C;
    }
  | Rejection;

/**
 * S and C are this version's snapshot and config types. The stored snapshot
 * and config arrive in the old version's shapes, which this version's types
 * do not describe, so they are plain objects; `from` names that version.
 *
 * Pure, like step. An agent that leaves it out keeps the stored snapshot
 * and config as they are when upgraded.
 */
export type Migrate<S extends JsonObject, C extends JsonObject> = (
  snapshot: JsonObject,
  config: JsonObject,
  from: string,
) => MigrateResult<S, C>;
