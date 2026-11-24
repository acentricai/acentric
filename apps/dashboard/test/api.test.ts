// How a failed call is said: the server's refusal, the server not reached, or the page's own error.

import { describe, expect, it, vi } from 'vitest';

import { ApiError, api, errorText, Unreachable } from '../src/api.ts';

describe('a failed call, in words', () => {
  it('says the server was not reached only when fetch itself failed', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const failed = await api.call('me.get').catch((error: unknown) => error);
    vi.unstubAllGlobals();
    expect(failed).toBeInstanceOf(Unreachable);
    expect(errorText(failed)).toBe('The server could not be reached.');
  });

  it('says the page’s own error as it is, not as the server’s', () => {
    // As a page that reads a list as something else throws.
    expect(errorText(new TypeError('object is not iterable'))).toBe(
      'The page failed: object is not iterable',
    );
    expect(errorText(new ApiError(403, { message: 'Not yours.' }))).toBe('Not yours.');
  });
});
