// The tools part's config: what the agent's tools need, such as the id of a
// machine they run on. Empty until a tool needs some.

import { Type } from 'typebox';
import type { Static } from 'typebox';

export const ToolsConfig = Type.Object({});
export type ToolsConfig = Static<typeof ToolsConfig>;
