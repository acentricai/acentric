// The Agents section: the engine's agents, their actors, deployments and secrets, and each
// actor's conversation. Shown to a person who may read agents.

import { IconHexagon, IconHexagonFilled } from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { ActorPage } from './pages/actor.tsx';
import { AgentsPage } from './pages/agents.tsx';
import {
  ActorsPage,
  AgentDashboard,
  DeploymentsPage,
  OverviewPage,
  SecretsPage,
  SettingsPage,
} from './pages/dashboard.tsx';
import { actorSearch, actorsSearch, deploymentsSearch } from './url.ts';

/**
 * `/agents`; an agent's own dashboard, `/agents/$agent` (its overview), `actors`, `deployments`,
 * `secrets` and `settings`; and `/actors/$actor`.
 */
function routes(parent: AnyRoute): AnyRoute[] {
  const agents = createRoute({
    getParentRoute: () => parent,
    path: 'agents',
    component: AgentsPage,
  });
  const agent = createRoute({
    getParentRoute: () => parent,
    path: 'agents/$agent',
    component: AgentDashboard,
  });
  const page = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => agent, path, component });
  const actors = createRoute({
    getParentRoute: () => agent,
    path: 'actors',
    validateSearch: actorsSearch,
    component: ActorsPage,
  });
  const deployments = createRoute({
    getParentRoute: () => agent,
    path: 'deployments',
    validateSearch: deploymentsSearch,
    component: DeploymentsPage,
  });
  const actor = createRoute({
    getParentRoute: () => parent,
    path: 'actors/$actor',
    validateSearch: actorSearch,
    component: ActorPage,
  });
  return [
    agents,
    agent.addChildren([
      page('/', OverviewPage),
      actors,
      deployments,
      page('secrets', SecretsPage),
      page('settings', SettingsPage),
    ]),
    actor,
  ];
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
