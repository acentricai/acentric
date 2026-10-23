// The pi agent's config, as its creator gives it, and the settings init
// resolves from it.
//
// Most of the config is optional. Init fills in the defaults and keeps the
// result in the snapshot as `settings`, so step never handles a missing
// field. The config itself stays exactly as given; a `config` message
// resolves the settings again.

import type { ModelRef, ThinkingLevel } from './content.js';

export type CompactionSettings = {
  /** Whether history is summarised automatically as the context fills. */
  enabled: boolean;
  /** Tokens kept free for the model's reply: compaction starts above the context window minus this. */
  reserveTokens: number;
  /** Roughly how many tokens of recent conversation compaction keeps as they are. */
  keepRecentTokens: number;
};

export type RetrySettings = {
  /** Whether failed model calls that may succeed later are retried. */
  enabled: boolean;
  /** Retries in a row before giving up. */
  maxRetries: number;
  /** The first wait; each retry doubles it. */
  baseDelayMs: number;
  /** The longest wait. */
  maxDelayMs: number;
};

/** How queued messages are given to the model: the oldest one, or all at once. */
export type QueueMode = 'one-at-a-time' | 'all';

/** The config as the creator gives it. */
export type PiConfig = {
  /** The working directory tools run in. */
  cwd: string;
  /** The model to start with. Must be in the catalog. */
  model: ModelRef;
  /** Defaults to 'medium'. */
  thinkingLevel?: ThinkingLevel;
  /** Defaults to enabled, 16384 reserved, 20000 kept. */
  compaction?: Partial<CompactionSettings>;
  /** Defaults to enabled, 3 retries, 2000 ms doubling up to 60000 ms. */
  retry?: Partial<RetrySettings>;
  /** Defaults to 'one-at-a-time'. */
  steeringMode?: QueueMode;
  /** Defaults to 'one-at-a-time'. */
  followUpMode?: QueueMode;
};

/** The config with every default filled in. */
export type Settings = {
  cwd: string;
  compaction: CompactionSettings;
  retry: RetrySettings;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
};
