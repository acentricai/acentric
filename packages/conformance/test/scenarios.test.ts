// Plays every scenario against the reference adapter. Scenarios that need
// a durable runner or upgrades are skipped here; they run against the first
// runner that offers them.

import { describe, expect, it } from 'vitest';

import { loadScenarios, play } from '../src/index.js';
import { referenceAdapter } from './reference.js';

const scenarios = await loadScenarios();

describe('scenarios, against the reference adapter', () => {
  it('finds the scenario files', () => {
    expect(scenarios.length).toBeGreaterThan(30);
  });

  for (const scenario of scenarios) {
    it(`§${scenario.section} ${scenario.name}`, async () => {
      const result = await play(scenario, () => Promise.resolve(referenceAdapter()));
      if (result.status === 'skipped') {
        expect(result.missing.length).toBeGreaterThan(0);
        return;
      }
      expect(result).toEqual({ name: scenario.name, status: 'passed' });
    });
  }
});
