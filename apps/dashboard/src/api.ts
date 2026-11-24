// The server's API, as the dashboard calls it. The dashboard is served by the server, so it calls
// its own origin, and a person signed in is known by the session cookie the browser sends: the
// page never holds a credential of its own.

import { ApiError, createClient } from '@acentric/client';
import type { Principal } from '@acentric/protocol';
import { QueryClient } from '@tanstack/react-query';

export { ApiError };

/** What is called when the server answers that no one is signed in, to a call made as someone. */
let onSignedOut: () => void = () => {};

/** Sets what happens when the server no longer knows the person signed in. */
export function whenSignedOut(then: () => void): void {
  onSignedOut = then;
}

/**
 * The routes that answer 401 to a person who is not signed in, or who gave a wrong password:
 * their 401 is the call's own answer, and signs no one out.
 */
const ANSWERS_SIGNED_OUT = ['/v1/me', '/v1/sign-in', '/v1/me/password'];

/**
 * The server was not reached at all: `fetch` itself failed, as it does with no network. Told apart
 * from an error of the page's own, which is not the server's.
 */
export class Unreachable extends Error {
  override readonly name = 'Unreachable';
}

/** `fetch`, telling the page when the server answers that no one is signed in. */
const watched: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    // A call the page stopped is not the server's failure.
    if (init?.signal?.aborted === true) throw error;
    throw new Unreachable('The server could not be reached.', { cause: error });
  }
  if (response.status === 401) {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (!ANSWERS_SIGNED_OUT.includes(path)) onSignedOut();
  }
  return response;
};

export const api = createClient({ baseUrl: window.location.origin, fetch: watched });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal is the answer, and an error of the page's own is not mended by asking again:
      // only a failure to reach the server is tried again.
      retry: (failures, error) => error instanceof Unreachable && failures < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export const keys = {
  me: ['me'] as const,
};

/** Who is signed in: the server's answer, or the error it refused with. */
export const meQuery = {
  queryKey: keys.me,
  queryFn: (): Promise<Principal> => api.call('me.get'),
  staleTime: 60_000,
};

/** Whether an error is the server's refusal, with this status or code. */
export function isApiError(error: unknown, status?: number, code?: string): error is ApiError {
  return (
    error instanceof ApiError &&
    (status === undefined || error.status === status) &&
    (code === undefined || error.code === code)
  );
}

/** Whether a read failed for now, and is worth trying again soon: the server was not reached, or was busy. */
export const isTransientRead = (error: unknown): boolean =>
  error instanceof Unreachable ||
  (error instanceof ApiError && (error.status === 429 || error.status >= 500));

/** A failed call, in words a person reads. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError || error instanceof Unreachable) return error.message;
  // Anything else is the page's own error, not the server's: said as it is, to be reported.
  return `The page failed: ${error instanceof Error ? error.message : String(error)}`;
}
