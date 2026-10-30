// The retry part's side of the loop: whether a failed model call is tried
// again, and when. As in meals: a failure the provider says may succeed
// later, or a runner timeout, with retries left, waiting twice as long each
// time, or as long as the provider asks, up to the most.

import type { LlmFailure } from '@acentric/llm';
import type { FailureCode } from '@acentric/types';

import type { RetrySettings } from './settings.js';
import type { RetryState } from './state.js';

export function shouldRetry(
  failure: LlmFailure | null,
  code: FailureCode | 'interrupted',
  state: RetryState,
  settings: RetrySettings,
): boolean {
  if (state.retries >= settings.retry.maxRetries) return false;
  return failure === null ? code === 'timeout' || code === 'interrupted' : failure.retryable;
}

/** When to try again, `state` counting this failure. */
export function retryAt(
  now: number,
  state: RetryState,
  failure: LlmFailure | null,
  settings: RetrySettings,
): number {
  const { baseDelayMs, maxDelayMs } = settings.retry;
  const backoff = baseDelayMs * 2 ** (state.retries - 1);
  return now + Math.min(Math.max(backoff, failure?.retryAfterMs ?? 0), maxDelayMs);
}

/** The retry part once a model call failed and will be tried again. */
export function failedOnce(state: RetryState): RetryState {
  return { retries: state.retries + 1 };
}

/** The retry part when a turn starts, or a model call succeeds. */
export function reset(): RetryState {
  return { retries: 0 };
}
