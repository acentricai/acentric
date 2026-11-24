// What a session is called when its sign-in said nothing: the browser it came from.

import { describe, expect, it } from 'vitest';

import { deviceOf } from '../src/device.ts';

describe('the device a sign-in came from', () => {
  it('is the browser and its system, as a person reads them', () => {
    const agents: readonly (readonly [string, string | undefined])[] = [
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Chrome (Mac OS X)',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
        'Safari (Mac OS X)',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
        'Edge (Windows)',
      ],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox (Linux)'],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
        'Safari (iOS)',
      ],
      [
        'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
        'Chrome (Android)',
      ],
      ['node', undefined],
      ['curl/8.7.1', undefined],
    ];
    for (const [agent, named] of agents) expect(deviceOf(agent), agent).toBe(named);
    expect(deviceOf(null)).toBeUndefined();
  });
});
