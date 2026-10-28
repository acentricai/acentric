// The log: every part's kinds of entry side by side. Conversation entries,
// and the compaction part's summary, are what the model sees; every other
// kind is a record for the agent and its UIs.

import type { CompactionEntries } from '../compaction/index.js';
import { logOf } from '../core/log.js';
import type { ConversationEntries, NoticeEntries } from '../core/log.js';
import type { CustomEntries } from '../custom/index.js';
import type { InputsEntries } from '../inputs/index.js';
import type { ModelEntries } from '../model/index.js';
import type { ToolsEntries } from '../tools/index.js';

/** Every kind of entry, with its body. */
export type LogBodies = ConversationEntries &
  NoticeEntries &
  InputsEntries &
  ModelEntries &
  CompactionEntries &
  ToolsEntries &
  CustomEntries;

export type LogKind = keyof LogBodies;

/** Typed helpers for the whole log. */
export const log = logOf<LogBodies>();
