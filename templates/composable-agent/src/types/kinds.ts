// Every kind of effect the agent may request: every part's kinds side by
// side, with what each takes and returns. A runner checks when it loads the
// agent that each one named in KIND_NAMES has a handler, or is its own.

import type { CompactionKinds } from '../compaction/index.js';
import type { RunnerKinds } from '../core/kinds.js';
import type { LoopKinds } from '../loop/kinds.js';
import { TOOL_KINDS } from '../tools/index.js';
import type { ToolKinds } from '../tools/index.js';

export type Kinds = LoopKinds & CompactionKinds & ToolKinds & RunnerKinds;

export const KIND_NAMES: (keyof Kinds)[] = ['llm', 'summarize', ...TOOL_KINDS, '@timer'];
