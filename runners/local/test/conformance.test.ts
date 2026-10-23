// Plays every conformance scenario against the local runner over SQLite. It
// offers every feature, so none are skipped.

import { loadScenarios, play } from '@acentric/conformance';
import { describe, expect, it } from 'vitest';

import { localAdapter } from './adapter.js';

const scenarios = await loadScenarios();

describe('conformance, against the local runner', () => {
  it('finds the scenario files', () => {
    expect(scenarios.length).toBeGreaterThan(30);
  });

  for (const scenario of scenarios) {
    it(`§${scenario.section} ${scenario.name}`, async () => {
      const result = await play(scenario, localAdapter);
      expect(result).toEqual({ name: scenario.name, status: 'passed' });
    });
  }
});
