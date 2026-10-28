// What the agent remembers between messages: every part's fields side by
// side. Every step rewrites it, so it holds control state and small
// pointers only: the conversation, tool arguments and summaries are in the
// log, found by seq. Settings are never stored; they come from config.
//
// Only init and step write it, and the runner checks it is plain JSON, so
// these are plain types: nothing checks them when they arrive.

import { INITIAL_COMPACTION } from '../compaction/index.js';
import type { CompactionState } from '../compaction/index.js';
import { initialCustom } from '../custom/index.js';
import type { CustomState } from '../custom/index.js';
import { INITIAL_INPUTS } from '../inputs/index.js';
import type { InputsState } from '../inputs/index.js';
import { INITIAL_LOOP, INITIAL_USAGE } from '../loop/state.js';
import type { LoopState, UsageState } from '../loop/state.js';
import { INITIAL_RETRY } from '../retry/index.js';
import type { RetryState } from '../retry/index.js';
import { initialTools } from '../tools/index.js';
import type { ToolsState } from '../tools/index.js';
import type { Settings } from './settings.js';

/** The whole snapshot. */
export type Snapshot = LoopState &
  UsageState &
  InputsState &
  CompactionState &
  RetryState &
  ToolsState &
  CustomState;

/** A new session's snapshot: idle, with nothing compacted, queued or spent. */
export function initialSnapshot(settings: Settings): Snapshot {
  return {
    ...INITIAL_LOOP,
    ...INITIAL_USAGE,
    ...INITIAL_INPUTS,
    ...INITIAL_COMPACTION,
    ...INITIAL_RETRY,
    ...initialTools(settings),
    ...initialCustom(settings),
  };
}
