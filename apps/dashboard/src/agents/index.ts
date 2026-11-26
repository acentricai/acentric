// The Agents section: the engine's agents, their actors, deployments and secrets, and each
// actor's conversation. Shown to a person who may read agents.

import { IconHexagon, IconHexagonFilled } from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { ActorPage } from './pages/actor.tsx';
import { ActorRedirect } from './pages/actor-redirect.tsx';
import { AgentsPage } from './pages/agents.tsx';
import { ActorsPage } from './pages/actors.tsx';
import { AgentDashboard } from './pages/dashboard.tsx';
import { OverviewPage } from './pages/overview.tsx';
import { DeploymentsPage } from './pages/deployments.tsx';
import { SecretsPage } from './pages/secrets.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { actorSearch, actorsSearch, deploymentsSearch } from './url.ts';

/**
 * `/agents`; an agent's own dashboard, `/agents/$agent` (its overview), `actors` and each
 * actor's page, `actors/$actor`, `deployments`, `secrets` and `settings`; and `/actors/$actor`,
 * which goes to an actor's page from its ID alone.
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
  // An actor's page is among its agent's Actors.
  const actor = createRoute({
    getParentRoute: () => agent,
    path: 'actors/$actor',
    validateSearch: actorSearch,
    component: ActorPage,
  });
  const byId = createRoute({
    getParentRoute: () => parent,
    path: 'actors/$actor',
    validateSearch: actorSearch,
    component: ActorRedirect,
  });
  return [
    agents,
    agent.addChildren([
      page('/', OverviewPage),
      actors,
      actor,
      deployments,
      page('secrets', SecretsPage),
      page('settings', SettingsPage),
    ]),
    byId,
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
