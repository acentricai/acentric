// The composable agent's pure half: what it remembers and how it responds.
// Its handlers are in handlers.ts.

import type { Agent, Window } from '@acentric/types';

import { compactionWindow } from './compaction/index.js';
import { inputsWindow } from './inputs/index.js';
import type { Config } from './types/config.js';
import { log } from './types/log.js';
import { readSettings } from './types/settings.js';
import { initialSnapshot } from './types/snapshot.js';
import type { Snapshot } from './types/snapshot.js';

/** Every kind of effect the agent may request: what each takes and returns. */
export type Kinds = Record<string, never>;

/**
 * The log a step sees: the earliest entry any part needs. The compaction
 * part needs everything from its first kept entry; the inputs part needs
 * the oldest queued message, to read it when its turn comes.
 */
const window: Window<Snapshot> = (snapshot) =>
  Math.min(compactionWindow(snapshot), inputsWindow(snapshot));

const agent: Agent<Snapshot, Config, Kinds> = {
  name: 'composable-agent',
  version: '0.1.0',
  init: (config) => {
    const read = readSettings(config);
    if ('error' in read) return read;
    return {
      snapshot: initialSnapshot(read.settings),
      append: [log.append('notice', { level: 'info', text: 'session created' })],
    };
  },
  step: ({ snapshot }, message) => {
    if (message.type === 'config') {
      const read = readSettings(message.config);
      if ('error' in read) return read;
    }
    return { snapshot };
  },
  window,
};

export default agent;
