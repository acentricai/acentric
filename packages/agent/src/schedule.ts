// What becomes of the model's `schedule` when it fires: the agent's own words for the notice,
// in place of the note alone.

import type { Context, Machine } from './context.ts';

/** A schedule as it fires. */
export type ScheduleFired = {
  /** What the model wrote for its later self. */
  readonly note: string;
  /** The time it was set for. */
  readonly dueAt: Date;
  /** The time it fired: later than `dueAt` when the engine was not running then. */
  readonly firedAt: Date;
};

/** `TConfig` is the actor's configuration. */
export type ScheduleOptions<TConfig = unknown, TMachine extends Machine | null = Machine | null> = {
  /** What the notice of a fired schedule says, in place of its note. */
  readonly handler: (
    fired: ScheduleFired,
    context: Context<TConfig, TMachine>,
  ) => string | Promise<string>;
};
