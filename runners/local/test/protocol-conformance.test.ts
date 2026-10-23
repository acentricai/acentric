// Plays every conformance scenario against the local runner through the
// protocol, with the runner in its own process: a crash kills it.

import { loadScenarios, play } from '@acentric/conformance';
import { describe, expect, it } from 'vitest';

import { protocolAdapter } from './protocol-adapter.js';

const scenarios = await loadScenarios();

describe('conformance, through the protocol', () => {
  for (const scenario of scenarios) {
    it(`§${scenario.section} ${scenario.name}`, async () => {
      const result = await play(scenario, protocolAdapter);
      expect(result).toEqual({ name: scenario.name, status: 'passed' });
    });
  }
});
