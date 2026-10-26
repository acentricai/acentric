import { describe, expect, it } from 'vitest';

import { estimateCost, findModel, MODELS } from '../src/index.js';
import type { ModelPricing } from '../src/index.js';

describe('the catalog', () => {
  it('finds a model by provider and ID, and nothing for one not listed', () => {
    expect(findModel('anthropic', 'claude-sonnet-5-5')).toMatchObject({
      name: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
    });
    expect(findModel('openai', 'gpt-6.1-sol')?.maxOutputTokens).toBe(128_000);
    expect(findModel('fireworks', 'accounts/fireworks/models/kimi-k3')?.provider).toBe('fireworks');
    expect(findModel('openai', 'claude-sonnet-5-5')).toBeUndefined();
    expect(findModel('openai', 'gpt-99')).toBeUndefined();
  });

  it('lists each model once, under its own provider, with prices', () => {
    for (const [provider, models] of Object.entries(MODELS)) {
      const ids = models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const model of models) {
        expect(model.provider).toBe(provider);
        expect(model.pricing?.base.input).toBeGreaterThan(0);
      }
    }
  });
});

describe('estimateCost', () => {
  const sonnet: ModelPricing = {
    base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  };

  it('prices each part per million tokens, and totals them', () => {
    expect(
      estimateCost(
        {
          totalInput: 1_600_000,
          input: 1_000_000,
          output: 100_000,
          cacheRead: 500_000,
          cacheWrite: 100_000,
        },
        sonnet,
      ),
    ).toEqual({
      source: 'estimated',
      input: 2,
      output: 1,
      cacheRead: expect.closeTo(0.05),
      cacheWrite: expect.closeTo(0.25),
      total: expect.closeTo(3.3),
    });
  });

  it('prices hour-long cache writes apart, and scales by the multiplier', () => {
    const cost = estimateCost(
      { totalInput: 300_000, input: 0, output: 0, cacheWrite: 300_000 },
      sonnet,
      { cacheWrite1h: 100_000, multiplier: 2 },
    );
    // 200,000 at 2.5 and 100,000 at 4, doubled.
    expect(cost?.cacheWrite).toBeCloseTo(1.8);
    expect(cost?.total).toBeCloseTo(1.8);
  });

  it('uses the highest tier the whole prompt is over', () => {
    const haiku = findModel('anthropic', 'claude-haiku-5-5')?.pricing;
    const small = estimateCost({ totalInput: 100_000, input: 100_000, output: 0 }, haiku);
    const large = estimateCost({ totalInput: 100_001, input: 100_001, output: 0 }, haiku);
    expect(small?.input).toBeCloseTo(0.01);
    expect(large?.input).toBeCloseTo(0.0500005);
  });

  it('gives no estimate when a count or a price is missing', () => {
    expect(estimateCost({ input: 10, output: 10 }, sonnet)).toBeUndefined();
    expect(estimateCost({ totalInput: 10, input: 10, output: 10 }, undefined)).toBeUndefined();
    const noCache: ModelPricing = { base: { input: 1, output: 1 } };
    expect(
      estimateCost({ totalInput: 20, input: 10, output: 10, cacheRead: 10 }, noCache),
    ).toBeUndefined();
    expect(estimateCost({ totalInput: 10, input: 10, output: 10, cacheRead: 0 }, noCache)).toEqual({
      source: 'estimated',
      input: expect.closeTo(0.00001, 10),
      output: expect.closeTo(0.00001, 10),
      total: expect.closeTo(0.00002, 10),
    });
  });
});
