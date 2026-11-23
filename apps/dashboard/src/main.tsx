import '@fontsource/fragment-mono/400.css';
import '@fontsource/geist-sans/300.css';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/base.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { queryClient, whenSignedOut } from './api.ts';
import { framed } from './frame-guard.ts';
import { changedElsewhere, makeRouter, signedOut } from './router.tsx';
import { applyTheme, onOtherTab, theme } from './session.ts';

applyTheme(theme());

const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root');

// Inside a frame nothing is shown, not even the page of signing in.
if (!framed()) {
  const router = makeRouter();
  whenSignedOut(() => signedOut(router));
  onOtherTab(() => changedElsewhere(router));
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
