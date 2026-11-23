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

/** `fetch`, telling the page when the server answers that no one is signed in. */
const watched: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
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
      // A refusal is the answer: only a failure to reach the server is tried again.
      retry: (failures, error) => !(error instanceof ApiError) && failures < 2,
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

/** A failed call, in words a person reads. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  // `fetch` rejects with a TypeError when the server cannot be reached at all.
  if (error instanceof TypeError) return 'The server could not be reached.';
  return error instanceof Error ? error.message : String(error);
}
