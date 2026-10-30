// The settings the agent works from: every part's config with its defaults
// filled in, checked as a whole. They are never stored: whatever needs them
// works them out from the config, so the two cannot disagree. Init and
// `config` messages run the same checks, so a stored config always gives
// settings.

import { compactionSettings } from '../compaction/index.js';
import type { CompactionSettings } from '../compaction/index.js';
import { customSettings } from '../custom/index.js';
import type { CustomSettings } from '../custom/index.js';
import { inputsSettings } from '../inputs/index.js';
import type { InputsSettings } from '../inputs/index.js';
import { modelSettings } from '../model/index.js';
import type { ModelSettings } from '../model/index.js';
import { retrySettings } from '../retry/index.js';
import type { RetrySettings } from '../retry/index.js';
import { toolsSettings } from '../tools/index.js';
import type { ToolsSettings } from '../tools/index.js';
import { readConfig } from './config.js';
import type { Config } from './config.js';

/** The whole settings: every part's fields side by side. */
export type Settings = ModelSettings &
  InputsSettings &
  CompactionSettings &
  RetrySettings &
  ToolsSettings &
  CustomSettings;

/** The settings a config gives, or what is wrong with it: its shape first, then the checks across fields. */
export function readSettings(value: unknown): { settings: Settings } | { error: string } {
  const read = readConfig(value);
  return 'error' in read ? read : resolveSettings(read.config);
}

/**
 * The settings of a config the session already accepted. It was checked
 * then, so it gives settings unless a new version of the code checks it
 * differently; then this throws, the step fails, and the runner stops the
 * session for someone to look at.
 */
export function settingsOf(config: Config): Settings {
  const resolved = resolveSettings(config);
  if ('error' in resolved) throw new Error(`the stored config no longer works: ${resolved.error}`);
  return resolved.settings;
}

/** The config with every default filled in, or why its fields do not work together. */
export function resolveSettings(config: Config): { settings: Settings } | { error: string } {
  const model = modelSettings(config);
  const compaction = compactionSettings(config, model.model);
  if ('error' in compaction) return { error: `invalid config: ${compaction.error}` };
  const retry = retrySettings(config);
  if ('error' in retry) return { error: `invalid config: ${retry.error}` };
  return {
    settings: {
      ...model,
      ...inputsSettings(config),
      ...compaction,
      ...retry,
      ...toolsSettings(config),
      ...customSettings(config),
    },
  };
}
