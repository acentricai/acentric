// The custom part's config: settings for the agent's own behaviour, such as
// keeping a prompt cache warm. Empty until it has some.

import { Type } from 'typebox';
import type { Static } from 'typebox';

export const CustomConfig = Type.Object({});
export type CustomConfig = Static<typeof CustomConfig>;
