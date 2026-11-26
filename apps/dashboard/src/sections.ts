// What each part of the dashboard brings: a collapsible section of tabs in the sidebar, and the
// routes those tabs lead to. The shell (src/shell) draws the sections in order; each part's pages
// live in their own folder (src/agents, src/machines) and know nothing of the others.

import type { Icon } from '@tabler/icons-react';
import type { AnyRoute } from '@tanstack/react-router';

import type { Me } from './me.ts';

export type Tab = {
  readonly id: string;
  readonly name: string;
  /** The path the tab goes to and is current on: `/agents`, `/machines`. */
  readonly path: string;
  readonly icon: Icon;
  /** Drawn when the tab is the current page. */
  readonly activeIcon: Icon;
  /** Whether the person signed in may see it. */
  readonly shown: (me: Me) => boolean;
  /** Current on its own path only, not on the pages below it. */
  readonly exact?: boolean;
};

export type Section = {
  readonly id: string;
  /** The collapsible head in the sidebar; a section without one is a plain list. */
  readonly label?: string;
  readonly tabs: readonly Tab[];
  /** The section's routes, children of the signed-in route the shell passes in. */
  routes(parent: AnyRoute): AnyRoute[];
};
