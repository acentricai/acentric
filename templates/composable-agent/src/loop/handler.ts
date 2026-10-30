// The llm handler: the model call, imported by handlers.ts and never by the
// agent. It reads the entries its args name from the log, builds the
// request, and calls the model once; a failure is an LlmError, which step
// reads back with llmFailure.

import type { LlmResponse } from '@acentric/llm';
import { createLlm } from '@acentric/llm/client';
import type { LlmOptions } from '@acentric/llm/client';
import type { HandlerDef } from '@acentric/types';

import { readEntries } from '../core/read.js';
import type { LlmArgs } from './kinds.js';
import { buildRequest } from './request.js';

/** `options` are @acentric/llm's, such as a fetch for tests. */
export function llmHandler(options: LlmOptions = {}): HandlerDef<LlmArgs, LlmResponse> {
  return {
    mode: 'reissue',
    run: async (ctx) => {
      const { fromSeq, toSeq } = ctx.args.context;
      const entries = await readEntries(ctx.log, fromSeq, toSeq);
      return createLlm(ctx, options).complete(buildRequest(ctx.args, entries));
    },
  };
}
