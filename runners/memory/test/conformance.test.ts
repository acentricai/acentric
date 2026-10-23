// Plays every conformance scenario against the memory runner. It offers
// every feature, so none are skipped.

import { loadScenarios, play } from '@acentric/conformance';
import { describe, expect, it } from 'vitest';

import { memoryAdapter } from './adapter.js';

const scenarios = await loadScenarios();

describe('conformance, against the memory runner', () => {
  it('finds the scenario files', () => {
    expect(scenarios.length).toBeGreaterThan(30);
  });

  for (const scenario of scenarios) {
    it(`§${scenario.section} ${scenario.name}`, async () => {
      const result = await play(scenario, () => Promise.resolve(memoryAdapter()));
      expect(result).toEqual({ name: scenario.name, status: 'passed' });
    });
  }
});
