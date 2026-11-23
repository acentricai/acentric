// How money, tokens and days are written, and the steps of a chart's axis.

import { describe, expect, it } from 'vitest';

import {
  cacheShare,
  compact,
  dayLabel,
  daysBetween,
  dollars,
  percent,
  providerName,
  rangeStart,
  ticks,
} from '../src/llm/format.ts';

describe('money and counts', () => {
  it('writes dollars to the cent, and to four places under one', () => {
    expect([0, 0.0042, 0.42, 12.5, 1234.567].map(dollars)).toEqual([
      '$0.00',
      '$0.0042',
      '$0.42',
      '$12.50',
      '$1,234.57',
    ]);
  });

  it('writes counts in full under ten thousand, and compact past it', () => {
    expect([0, 1284, 9999, 12_900, 373_220, 3_943_010, 2_500_000_000].map(compact)).toEqual([
      '0',
      '1,284',
      '9,999',
      '12.9K',
      '373.2K',
      '3.9M',
      '2.5B',
    ]);
  });
});

describe('days', () => {
  it('are the UTC days of a range, ending today, each named as the ledger names it', () => {
    const now = Date.parse('2026-11-20T15:00:00Z');
    const from = rangeStart(7, now);
    expect(new Date(from).toISOString()).toBe('2026-11-14T00:00:00.000Z');
    const days = daysBetween(from, now);
    expect(days).toEqual([
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
    ]);
    expect(dayLabel('2026-11-04')).toBe('Nov 4');
    // Across a month's end.
    expect(
      daysBetween(Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-11-01T01:00:00Z')),
    ).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('an axis', () => {
  it('goes from 0 to at least the largest value in a few round steps', () => {
    expect(ticks(0)).toEqual([0]);
    expect(ticks(3.1)).toEqual([0, 2, 4]);
    expect(ticks(0.042)).toEqual([0, 0.02, 0.04, 0.06]);
    expect(ticks(870)).toEqual([0, 500, 1000]);
    for (const max of [0.0003, 1, 7.7, 59.16, 12_345]) {
      const steps = ticks(max);
      expect(steps.at(-1)).toBeGreaterThanOrEqual(max);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('a provider', () => {
  it('is named as the engine names it, and by its ID when the dashboard does not know it', () => {
    expect(['openai', 'anthropic', 'chatgpt', 'fireworks', 'acme'].map(providerName)).toEqual([
      'OpenAI',
      'Anthropic',
      'ChatGPT',
      'Fireworks',
      'acme',
    ]);
  });
});

describe('the prompt cache', () => {
  it('is the share of the input read from cache, as a percent', () => {
    expect(cacheShare({ cacheRead: 620, totalInput: 1000 })).toBe(0.62);
    expect(cacheShare({ cacheRead: 0, totalInput: 0 })).toBeUndefined();
    expect(percent(0.62)).toBe('62%');
    expect(percent(0.004)).toBe('<1%');
    expect(percent(0)).toBe('0%');
    expect(percent(1)).toBe('100%');
    expect(percent(undefined)).toBe('—');
  });
});
