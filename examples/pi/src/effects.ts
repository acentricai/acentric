// The effects that should exist: read straight from the run's phase.

import type { EffectRequest, Effects } from '@acentric/types';

import type { PiConfig } from './config.js';
import type { PiKinds } from './kinds.js';
import type { PiSnapshot } from './snapshot.js';
import type { ToolName } from './tools.js';

export const effects: Effects<PiSnapshot, PiConfig, PiKinds> = (state) => {
  const snapshot = state.snapshot;
  const { phase, compaction } = snapshot;
  const cwd = snapshot.settings.cwd;
  const fromSeq = compaction?.firstKeptSeq ?? 1;
  const compactionSeq = compaction?.seq ?? null;

  switch (phase.kind) {
    case 'idle':
      return [];
    case 'calling_llm':
      return [
        {
          key: phase.key,
          kind: 'llm',
          args: {
            model: phase.model,
            thinkingLevel: phase.thinkingLevel,
            cwd,
            compactionSeq,
            fromSeq,
            toSeq: phase.toSeq,
          },
          ...(phase.aborting === null ? {} : { abort: true }),
        },
      ];
    case 'running_tools':
      return phase.calls.flatMap((call): EffectRequest<PiKinds>[] => {
        if (call.status !== 'running' || call.key === null || !isToolName(call.toolName)) return [];
        return [
          {
            key: call.key,
            kind: call.toolName,
            args: { seq: phase.assistantSeq, toolCallId: call.toolCallId, cwd },
            ...(phase.aborting === null ? {} : { abort: true }),
          },
        ];
      });
    case 'waiting_retry':
      return [{ key: phase.key, kind: '@timer', args: { at: phase.at } }];
    case 'compacting':
      return [
        {
          key: phase.key,
          kind: 'summarize',
          args: {
            model: snapshot.model,
            fromSeq,
            toSeq: phase.firstKeptSeq,
            previousSummarySeq: compactionSeq,
            instructions: phase.instructions,
          },
        },
      ];
  }
};

function isToolName(name: string): name is ToolName {
  return name === 'read' || name === 'bash' || name === 'edit' || name === 'write';
}
