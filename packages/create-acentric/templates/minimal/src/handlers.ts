// The agent's handlers: where its I/O goes, such as calling a model or an
// API. Each handler runs one kind of effect, in a separate process from the
// pure half.
//
// This agent has none of its own: its only effect, `@timer`, is the
// runner's. To add one, name its kind and types in NotesKinds in agent.ts,
// add it to `kinds` there, declare effects of that kind in `effects`, and
// write its handler here:
//
//   fetch_title: {
//     mode: 'reissue',
//     run: async (ctx) => (await fetch(ctx.args.url)).statusText,
//   },

import type { HandlersFor } from '@acentric/types';

import type { NotesKinds } from './agent.js';

const handlers: HandlersFor<NotesKinds> = {};

export default handlers;
