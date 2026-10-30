// The effects that should exist, read straight from the phase, beside the
// custom part's own. Once a turn is stopping, a model call and tool calls
// are declared with `abort`, so their handlers get the signal and still
// report what they have.

import type { EffectRequest, Effects } from '@acentric/types';

import * as compaction from '../compaction/index.js';
import * as custom from '../custom/index.js';
import { toolKind } from '../tools/index.js';
import type { Config } from '../types/config.js';
import type { Kinds } from '../types/kinds.js';
import { settingsOf } from '../types/settings.js';
import type { Settings } from '../types/settings.js';
import type { Snapshot } from '../types/snapshot.js';

export const effects: Effects<Snapshot, Config, Kinds> = ({ snapshot, config }) => {
  const settings = settingsOf(config);
  return [...phaseEffects(snapshot, settings), ...custom.customEffects(snapshot, settings)];
};

function phaseEffects(snapshot: Snapshot, settings: Settings): EffectRequest<Kinds>[] {
  const { phase } = snapshot;
  const abort = snapshot.turn?.stopping === true;
  switch (phase.type) {
    case 'idle':
      return [];
    case 'calling_model':
      return [{ key: phase.key, kind: 'llm', args: phase.args, abort }];
    case 'running_tools':
      return phase.calls
        .filter((call) => call.status === 'running')
        .map((call) => ({
          key: call.key,
          kind: toolKind(call.name),
          args: { replySeq: phase.replySeq, callId: call.callId, extra: call.extra },
          abort,
        }));
    case 'waiting_retry':
      return [{ key: phase.key, kind: '@timer', args: { at: phase.at } }];
    case 'compacting':
      return [
        {
          key: phase.key,
          kind: 'summarize',
          args: compaction.summarizeArgs(snapshot, phase, settings),
        },
      ];
  }
}
