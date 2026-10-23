// Conformance: the scenarios every runner must pass, the probe agent they
// drive, and a player for runners written in TypeScript.

export { createGateHook, installedHook, isJson } from './hook.js';
export type { ConformanceHook, GateControl, GateOutcome } from './hook.js';
export { GATE_SERVER_ENV, serveGates } from './gate-server.js';
export type { GateServer } from './gate-server.js';
export { loadScenarios, scenariosDir } from './load.js';
export { mismatch } from './match.js';
export { play } from './player.js';
export type { Adapter, Answer, RunningEffect, ScenarioResult } from './player.js';
export type {
  Bundle,
  Expectation,
  Feature,
  RunningExpectation,
  Scenario,
  ScenarioStep,
} from './scenario.js';
