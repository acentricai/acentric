// Runs an agent's pure half in memory, and its handlers on their own, for
// tests. The simulation and replay come from @acentric/replay.

export { handlerContext } from './handler.js';
export type { HandlerContextOptions, TestHandlerContext } from './handler.js';
export {
  assertJson,
  canonicalJson,
  deepFreeze,
  forReplay,
  journalDigest,
  replay,
  simulate,
  Simulation,
  SimulationError,
} from '@acentric/replay';
export type {
  Delivery,
  Replay,
  ReplayAgent,
  ReplayedEntry,
  ReplayOptions,
  SimulateOptions,
} from '@acentric/replay';
