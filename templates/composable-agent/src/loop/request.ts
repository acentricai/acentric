// The request a model call sends, built from its args and the entries they
// name. The `llm` handler builds it; anything pure that must send exactly
// what the next call would, such as warming a prompt cache, can too.

import type { LlmRequest } from '@acentric/llm';
import type { LogEntry } from '@acentric/types';

import { context } from '../compaction/index.js';
import { requestFor } from '../core/request.js';
import { thinkingOptions } from '../model/index.js';
import { instructions } from '../prompt/index.js';
import { toolDefinitions } from '../tools/index.js';
import type { LlmArgs } from './kinds.js';

/** `entries` hold every entry `args.context` names. */
export function buildRequest(args: LlmArgs, entries: readonly LogEntry[]): LlmRequest {
  return requestFor(args.model, {
    instructions: instructions(args.prompt),
    messages: context(entries, args.context),
    tools: toolDefinitions(args.tools),
    options: thinkingOptions(args.thinking),
  });
}
