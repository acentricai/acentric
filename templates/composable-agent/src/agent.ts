// The composable agent's pure half: what it remembers and how it responds.
// Its handlers are in handlers.ts. What step does is in loop/step.ts, and
// STEP.md says it in words.

import type { Agent, Window } from '@acentric/types';

import { compactionWindow } from './compaction/index.js';
import { inputsWindow } from './inputs/index.js';
import { effects } from './loop/effects.js';
import { step } from './loop/step.js';
import type { Config } from './types/config.js';
import { KIND_NAMES } from './types/kinds.js';
import type { Kinds } from './types/kinds.js';
import { log } from './types/log.js';
import { readSettings } from './types/settings.js';
import { initialSnapshot } from './types/snapshot.js';
import type { Snapshot } from './types/snapshot.js';

/**
 * The log a step sees: the earliest entry any part needs. The compaction
 * part needs everything from its first kept entry; the inputs part needs
 * the oldest waiting message, to read it when its turn comes.
 */
const window: Window<Snapshot> = (snapshot) =>
  Math.min(compactionWindow(snapshot), inputsWindow(snapshot));

const agent: Agent<Snapshot, Config, Kinds> = {
  name: 'composable-agent',
  version: '0.1.0',
  kinds: KIND_NAMES,
  init: (config) => {
    const read = readSettings(config);
    if ('error' in read) return read;
    return {
      snapshot: initialSnapshot(read.settings),
      append: [log.append('notice', { level: 'info', text: 'session created' })],
    };
  },
  step,
  effects,
  window,
};

export default agent;
