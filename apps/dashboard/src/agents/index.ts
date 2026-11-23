// The Agents section. Its page is empty for now: what it shows comes later.

import { IconHexagon, IconHexagonFilled } from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { AgentsPage } from './agents.tsx';

function routes(parent: AnyRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => parent, path: 'agents', component: AgentsPage })];
}

export const agentsSection: Section = {
  id: 'agents',
  label: 'Agents',
  tabs: [
    {
      id: 'agents',
      name: 'Agents',
      path: '/agents',
      icon: IconHexagon,
      activeIcon: IconHexagonFilled,
      shown: (me) => may(me, 'agents:read'),
    },
  ],
  routes,
};
