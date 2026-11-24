// The dashboard as a test opens it: at an address, with a stand-in server as its `fetch`.

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { queryClient, whenSignedOut } from '../src/api.ts';
import { makeRouter, signedOut } from '../src/router.tsx';
import { resetUpdating } from '../src/updating.tsx';
import { fakeServer } from './server.ts';
import type { FakeServer } from './server.ts';

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetUpdating();
  vi.unstubAllGlobals();
});

export function open(path: string, server: FakeServer = fakeServer()) {
  vi.stubGlobal('fetch', server.fetch);
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  whenSignedOut(() => signedOut(router));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, server, where: () => router.state.location.href };
}
