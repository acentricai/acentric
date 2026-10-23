// pi's coding agent as an acentric agent: the pure half. Handlers come
// separately.

import type { Agent, Init, View, Window } from '@acentric/types';

import { findModel } from './catalog.js';
import type { PiConfig } from './config.js';
import { effects } from './effects.js';
import type { PiKinds } from './kinds.js';
import { resolveConfig } from './settings.js';
import type { PiSnapshot } from './snapshot.js';
import { step } from './step.js';
import { estimateContext } from './tokens.js';
import { entryAt } from './entries.js';

export const init: Init<PiSnapshot, PiConfig> = (config) => {
  const resolved = resolveConfig(config);
  if ('error' in resolved) return { error: resolved.error };
  const { settings, model, thinkingLevel } = resolved;
  return {
    snapshot: {
      settings,
      model,
      thinkingLevel,
      phase: { kind: 'idle' },
      steering: [],
      followUps: [],
      retries: 0,
      overflowRecovered: false,
      compaction: null,
      nextKey: 1,
    },
    append: [
      { kind: 'model_change', body: { model } },
      { kind: 'thinking_change', body: { level: thinkingLevel } },
    ],
  };
};

/**
 * From the latest compaction's first kept entry, or from the oldest queued
 * message if that is older, so step can still read it when its turn comes.
 */
export const window: Window<PiSnapshot> = (snapshot) =>
  Math.min(snapshot.compaction?.firstKeptSeq ?? 1, ...snapshot.steering, ...snapshot.followUps);

export const view: View<PiSnapshot, PiConfig> = (state) => {
  const { snapshot, log } = state;
  const compaction = snapshot.compaction;
  const summary =
    compaction === null
      ? null
      : (entryAt(log.entries, compaction.seq, 'compaction')?.body.summary ?? null);
  const from = compaction?.firstKeptSeq ?? 1;
  const context = log.entries.filter((entry) => entry.seq >= from);
  return {
    phase: snapshot.phase.kind,
    aborting: 'aborting' in snapshot.phase && snapshot.phase.aborting !== null,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    queued: { steering: snapshot.steering.length, followUps: snapshot.followUps.length },
    retries: snapshot.retries,
    contextTokens: estimateContext(context, summary, snapshot.settings.cwd),
    contextWindow: findModel(snapshot.model)?.contextWindow ?? null,
  };
};

export const piAgent: Agent<PiSnapshot, PiConfig, PiKinds> = {
  name: 'pi',
  version: '0.1.0',
  init,
  step,
  effects,
  window,
  view,
  kinds: ['llm', 'read', 'bash', 'edit', 'write', 'summarize', '@timer'],
};
