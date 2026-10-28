// The session's config, as its creator sends it: every part's fields side
// by side. Each part's schema gives its TypeScript type and the check that
// init and `config` messages run on what arrives. Every field is optional:
// a session can be created with `{}`, and defaults fill in the rest.
//
// No secrets here: config is stored. API keys are the handlers' secrets.

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { CompactionConfig } from '../compaction/index.js';
import { problems } from '../core/check.js';
import { CustomConfig } from '../custom/index.js';
import { InputsConfig } from '../inputs/index.js';
import { ModelConfig } from '../model/index.js';
import { RetryConfig } from '../retry/index.js';
import { ToolsConfig } from '../tools/index.js';

/** The whole config. Unknown fields are refused. */
export const Config = Type.Object(
  {
    ...ModelConfig.properties,
    ...InputsConfig.properties,
    ...CompactionConfig.properties,
    ...RetryConfig.properties,
    ...ToolsConfig.properties,
    ...CustomConfig.properties,
  },
  { additionalProperties: false },
);
export type Config = Static<typeof Config>;

/** The config if it fits the schema, or what is wrong with it. */
export function readConfig(value: unknown): { config: Config } | { error: string } {
  if (Value.Check(Config, value)) return { config: value };
  return { error: `invalid config: ${problems(Config, value, 'config').join('; ')}` };
}
