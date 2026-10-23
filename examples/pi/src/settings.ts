// Resolves the config the creator gives into complete settings.

import type { Json, JsonObject } from '@acentric/types';

import { findModel } from './catalog.js';
import type { CompactionSettings, QueueMode, RetrySettings, Settings } from './config.js';
import type { ModelRef, ThinkingLevel } from './content.js';
import { isModelRef, isNumberFrom, isObject, isThinkingLevel } from './guards.js';

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export const DEFAULT_RETRY: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export const DEFAULT_QUEUE_MODE: QueueMode = 'one-at-a-time';

/** The settings from a config, and the model and thinking level it starts with. */
export type Resolved = {
  settings: Settings;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
};

/** Resolves a config, or says what is wrong with it. */
export function resolveConfig(config: JsonObject): Resolved | { error: string } {
  const cwd = config['cwd'];
  if (typeof cwd !== 'string' || cwd === '') return { error: 'cwd must be a non-empty string' };

  const model = config['model'];
  if (!isModelRef(model)) return { error: 'model must be { provider, id }' };
  if (!findModel(model)) return { error: `unknown model ${model.provider}/${model.id}` };

  const thinkingLevel = config['thinkingLevel'] ?? DEFAULT_THINKING_LEVEL;
  if (!isThinkingLevel(thinkingLevel)) return { error: 'thinkingLevel is not a thinking level' };

  const compaction = resolveCompaction(config['compaction']);
  if ('error' in compaction) return compaction;
  const retry = resolveRetry(config['retry']);
  if ('error' in retry) return retry;
  const steeringMode = resolveQueueMode(config['steeringMode'], 'steeringMode');
  if (typeof steeringMode !== 'string') return steeringMode;
  const followUpMode = resolveQueueMode(config['followUpMode'], 'followUpMode');
  if (typeof followUpMode !== 'string') return followUpMode;

  return {
    settings: { cwd, compaction, retry, steeringMode, followUpMode },
    model: { provider: model.provider, id: model.id },
    thinkingLevel,
  };
}

function resolveCompaction(value: Json | undefined): CompactionSettings | { error: string } {
  if (value === undefined) return DEFAULT_COMPACTION;
  if (!isObject(value)) return { error: 'compaction must be an object' };
  const enabled = value['enabled'] ?? DEFAULT_COMPACTION.enabled;
  const reserveTokens = value['reserveTokens'] ?? DEFAULT_COMPACTION.reserveTokens;
  const keepRecentTokens = value['keepRecentTokens'] ?? DEFAULT_COMPACTION.keepRecentTokens;
  if (typeof enabled !== 'boolean') return { error: 'compaction.enabled must be a boolean' };
  if (!isNumberFrom(reserveTokens, 0))
    return { error: 'compaction.reserveTokens must be a number' };
  if (!isNumberFrom(keepRecentTokens, 0))
    return { error: 'compaction.keepRecentTokens must be a number' };
  return { enabled, reserveTokens, keepRecentTokens };
}

function resolveRetry(value: Json | undefined): RetrySettings | { error: string } {
  if (value === undefined) return DEFAULT_RETRY;
  if (!isObject(value)) return { error: 'retry must be an object' };
  const enabled = value['enabled'] ?? DEFAULT_RETRY.enabled;
  const maxRetries = value['maxRetries'] ?? DEFAULT_RETRY.maxRetries;
  const baseDelayMs = value['baseDelayMs'] ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = value['maxDelayMs'] ?? DEFAULT_RETRY.maxDelayMs;
  if (typeof enabled !== 'boolean') return { error: 'retry.enabled must be a boolean' };
  if (!isNumberFrom(maxRetries, 0)) return { error: 'retry.maxRetries must be a number' };
  if (!isNumberFrom(baseDelayMs, 0)) return { error: 'retry.baseDelayMs must be a number' };
  if (!isNumberFrom(maxDelayMs, 0)) return { error: 'retry.maxDelayMs must be a number' };
  return { enabled, maxRetries, baseDelayMs, maxDelayMs };
}

function resolveQueueMode(value: Json | undefined, name: string): QueueMode | { error: string } {
  if (value === undefined) return DEFAULT_QUEUE_MODE;
  if (value === 'one-at-a-time' || value === 'all') return value;
  return { error: `${name} must be 'one-at-a-time' or 'all'` };
}
