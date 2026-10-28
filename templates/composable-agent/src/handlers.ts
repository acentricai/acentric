// The composable agent's handlers: its I/O, kept apart from the pure half.
// The kinds they serve are in agent.ts.

import type { HandlersFor } from '@acentric/types';

import type { Kinds } from './agent.js';

const handlers: HandlersFor<Kinds> = {};

export default handlers;
