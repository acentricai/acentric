// The retry part's snapshot part and phase.

export type RetryState = {
  /** Failed model calls in a row, for the backoff. */
  retries: number;
};

export const INITIAL_RETRY: RetryState = { retries: 0 };

/** Waiting until `at` to retry a failed model call. */
export type RetryPhase = { type: 'waiting_retry'; key: string; at: number };
