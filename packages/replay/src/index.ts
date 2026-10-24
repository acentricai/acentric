// Runs an agent's pure half with no runner: a simulation delivers messages
// to step and matches effects as a runner would, and replay delivers a
// session's journal again, saying where it differs. Runners use it to
// replay and fork sessions; @acentric/testing re-exports it for tests.

export { canonicalJson, journalDigest } from './digest.js';
export { assertJson, deepFreeze } from './json.js';
export { forReplay, replay } from './replay.js';
export type { Replay, ReplayAgent, ReplayedEntry, ReplayOptions } from './replay.js';
export { simulate, Simulation, SimulationError } from './simulate.js';
export type { Delivery, SimulateOptions } from './simulate.js';
