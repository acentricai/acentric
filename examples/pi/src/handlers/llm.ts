// The llm and summarize handlers: the agent's two kinds of model call, both
// through pi-ai.

import type { HandlerDef } from '@acentric/types';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import { generateSummaryWithUsage } from '@earendil-works/pi-coding-agent';

import type { AssistantMessage, ModelRef } from '../content.js';
import { buildContext } from '../context.js';
import type { LlmArgs, SummarizeArgs, Summary } from '../kinds.js';
import { systemPrompt } from '../prompt.js';
import { toolDeclarations } from '../tools.js';
import { fromPiAssistant, fromPiUsage, toPiMessages } from './convert.js';
import { apiKeySecret } from './keys.js';
import { readEntry, readRange } from './log.js';

/**
 * Calls the model with the agent's context: the system prompt, the latest
 * summary and the conversation in [fromSeq, toSeq), and the four tools.
 * When aborted, pi-ai ends the call with what had arrived and
 * `stopReason: 'aborted'`, and that is returned like any reply.
 */
export function llmHandler(models: Models): HandlerDef<LlmArgs, AssistantMessage> {
  return {
    mode: 'reissue',
    async run(ctx) {
      const { thinkingLevel, cwd, compactionSeq, fromSeq, toSeq } = ctx.args;
      const model = findModel(models, ctx.args.model);
      const summary =
        compactionSeq === null
          ? null
          : (await readEntry(ctx.log, compactionSeq, 'compaction')).body.summary;
      const entries = await readRange(ctx.log, fromSeq, toSeq);
      const apiKey = await ctx.secrets.get(apiKeySecret(model.provider));

      const reply = await models.completeSimple(
        model,
        {
          systemPrompt: systemPrompt(cwd),
          messages: toPiMessages(buildContext(entries, summary)),
          tools: toolDeclarations(),
        },
        {
          apiKey,
          signal: ctx.signal,
          ...(thinkingLevel === 'off' ? {} : { reasoning: thinkingLevel }),
        },
      );
      return fromPiAssistant(reply);
    },
  };
}

/**
 * Summarises the conversation in [fromSeq, toSeq) with pi's compaction
 * prompt, extending the previous summary if there is one.
 */
export function summarizeHandler(models: Models): HandlerDef<SummarizeArgs, Summary> {
  return {
    mode: 'reissue',
    async run(ctx) {
      const { fromSeq, toSeq, previousSummarySeq, instructions } = ctx.args;
      const model = findModel(models, ctx.args.model);
      const entries = await readRange(ctx.log, fromSeq, toSeq);
      const previous =
        previousSummarySeq === null
          ? undefined
          : (await readEntry(ctx.log, previousSummarySeq, 'compaction')).body.summary;
      const apiKey = await ctx.secrets.get(apiKeySecret(model.provider));

      const result = await generateSummaryWithUsage(
        toPiMessages(buildContext(entries, null)),
        model,
        undefined,
        apiKey,
        undefined,
        ctx.signal,
        instructions ?? undefined,
        previous,
        undefined,
        (requested, context, options) => models.streamSimple(requested, context, options),
      );
      return { summary: result.text, usage: fromPiUsage(result.usage) };
    },
  };
}

function findModel(models: Models, ref: ModelRef): Model<Api> {
  const model = models.getModel(ref.provider, ref.id);
  if (model === undefined) throw new Error(`unknown model ${ref.provider}/${ref.id}`);
  return model;
}
