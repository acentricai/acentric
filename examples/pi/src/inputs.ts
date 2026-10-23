// What callers can send the pi agent: the payload of each input kind.
//
// The framework gives every input a free-form `kind` and a Json object
// `payload`; these types say which kinds this agent understands and what
// each payload holds. Step rejects any other kind, and any payload of the
// wrong shape.

import type { ImageBlock, ModelRef, ThinkingLevel } from './content.js';

/** A message from the user, with optional images. */
export type UserText = {
  text: string;
  images?: ImageBlock[];
};

/** A payload with no fields. */
export type Empty = Record<string, never>;

export type PiInputs = {
  /** Start a run. Rejected while a run is going: use `steer` or `follow_up`. */
  prompt: UserText;
  /** Queued, and given to the model after the current tool calls, before its next call. */
  steer: UserText;
  /** Queued, and given to the model when the run would otherwise end. */
  follow_up: UserText;
  /**
   * Stop the run: abort the model call, keeping what it had said, stop any
   * tools, and clear the queued steer and follow-up messages.
   */
  abort: Empty;
  /** Use another model from the catalog from the next model call on. Rejected for an unknown one. */
  set_model: ModelRef;
  /** Use another thinking level from the next model call on. */
  set_thinking: { level: ThinkingLevel };
  /** Summarise older history now, optionally with extra instructions. */
  compact: { instructions?: string };
};

export type PiInputKind = keyof PiInputs;
