// Models, as @acentric/llm names them. Shared: the model part chooses the
// one that answers, and other parts name the models that do their work.

import type { Provider } from '@acentric/llm';
import { Type } from 'typebox';
import type { Static } from 'typebox';

/** The providers @acentric/llm supports. */
export const PROVIDERS = [
  'anthropic',
  'openai',
  'fireworks',
] as const satisfies readonly Provider[];

/** A model in @acentric/llm: its provider and the provider's id for it. */
export const ModelRef = Type.Object(
  { provider: Type.Enum(PROVIDERS), id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type ModelRef = Static<typeof ModelRef>;
