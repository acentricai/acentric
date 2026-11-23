// The Agents section: the engine's agents, their actors, deployments and secrets, and each
// actor's conversation. Shown to a person who may read agents.

import { IconHexagon, IconHexagonFilled } from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { ActorPage } from './pages/actor.tsx';
import { ActorsTab, AgentLayout, DeploymentsTab, SecretsTab } from './pages/agent.tsx';
import { AgentsPage } from './pages/agents.tsx';
import { actorSearch, actorsSearch, deploymentsSearch } from './url.ts';

/** `/agents`, `/agents/$agent` (actors, deployments, secrets), and `/actors/$actor`. */
function routes(parent: AnyRoute): AnyRoute[] {
  const agents = createRoute({
    getParentRoute: () => parent,
    path: 'agents',
    component: AgentsPage,
  });
  const agent = createRoute({
    getParentRoute: () => parent,
    path: 'agents/$agent',
    component: AgentLayout,
  });
  const actors = createRoute({
    getParentRoute: () => agent,
    path: '/',
    validateSearch: actorsSearch,
    component: ActorsTab,
  });
  const deployments = createRoute({
    getParentRoute: () => agent,
    path: 'deployments',
    validateSearch: deploymentsSearch,
    component: DeploymentsTab,
  });
  const secrets = createRoute({
    getParentRoute: () => agent,
    path: 'secrets',
    component: SecretsTab,
  });
  const actor = createRoute({
    getParentRoute: () => parent,
    path: 'actors/$actor',
    validateSearch: actorSearch,
    component: ActorPage,
  });
  return [agents, agent.addChildren([actors, deployments, secrets]), actor];
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
