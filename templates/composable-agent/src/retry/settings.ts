// The retry part's settings: its config with the defaults filled in.

import type { RetryConfig } from './config.js';

export type RetrySettings = {
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
};

export const DEFAULT_RETRY: RetrySettings['retry'] = {
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export function retrySettings(config: RetryConfig): RetrySettings | { error: string } {
  const retry = { ...DEFAULT_RETRY, ...config.retry };
  if (retry.baseDelayMs > retry.maxDelayMs) {
    return {
      error: `retry.baseDelayMs (${retry.baseDelayMs}) must not be above retry.maxDelayMs (${retry.maxDelayMs})`,
    };
  }
  return { retry };
}
