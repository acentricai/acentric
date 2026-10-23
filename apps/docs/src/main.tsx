import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
// The font and styles are imported for their effect on the page.
// oxlint-disable-next-line import/no-unassigned-import
import '@fontsource/fragment-mono/400.css';
// oxlint-disable-next-line import/no-unassigned-import
import './styles/tokens.css';
// oxlint-disable-next-line import/no-unassigned-import
import './styles/site.css';
// oxlint-disable-next-line import/no-unassigned-import
import './styles/prose.css';
import { router } from './router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
