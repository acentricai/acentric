// The composable agent's handlers: its I/O, kept apart from the pure half.
// The kinds they serve, and their args and results, are in types/kinds.ts.
// A tool's handler is made with toolHandler (tools/handler.ts) and goes
// under its kind, such as 'tool:read'.

import type { HandlersFor } from '@acentric/types';

import type { Kinds } from './types/kinds.js';

const handlers: HandlersFor<Kinds> = {};

export default handlers;
