// An agent's own dashboard: the sidebar's tabs while one agent is open, and their pages.

import {
  IconAdjustments,
  IconAdjustmentsFilled,
  IconKey,
  IconKeyFilled,
  IconLayoutDashboard,
  IconLayoutDashboardFilled,
  IconStack2,
  IconStack2Filled,
  IconUser,
  IconUserFilled,
} from '@tabler/icons-react';
import { Outlet } from '@tanstack/react-router';

import { may } from '../../me.ts';
import type { Section } from '../../sections.ts';
import { PageHeader } from '../../ui.tsx';
import { agentPath } from '../links.tsx';
import '../agents.css';

/** The agent an address is on, `/agents/<agent>` or a page below it; undefined elsewhere. */
export function agentAt(pathname: string): string | undefined {
  const match = /^\/agents\/([^/]+)/.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/** The sidebar's tabs for one agent. */
export function agentSection(agent: string): Section {
  const reads = (me: Parameters<typeof may>[0]) => may(me, 'agents:read');
  return {
    id: 'agent',
    tabs: [
      {
        id: 'overview',
        name: 'Overview',
        path: agentPath(agent),
        icon: IconLayoutDashboard,
        activeIcon: IconLayoutDashboardFilled,
        shown: reads,
        exact: true,
      },
      {
        id: 'actors',
        name: 'Actors',
        path: agentPath(agent, 'actors'),
        icon: IconUser,
        activeIcon: IconUserFilled,
        shown: reads,
      },
      {
        id: 'deployments',
        name: 'Deployments',
        path: agentPath(agent, 'deployments'),
        icon: IconStack2,
        activeIcon: IconStack2Filled,
        shown: reads,
      },
      {
        id: 'secrets',
        name: 'Secrets',
        path: agentPath(agent, 'secrets'),
        icon: IconKey,
        activeIcon: IconKeyFilled,
        shown: reads,
      },
      {
        id: 'settings',
        name: 'Settings',
        path: agentPath(agent, 'settings'),
        icon: IconAdjustments,
        activeIcon: IconAdjustmentsFilled,
        shown: reads,
      },
    ],
    routes: () => [],
  };
}

export function AgentDashboard() {
  return (
    <div className="list-page agent-dashboard">
      <Outlet />
    </div>
  );
}

export const OverviewPage = () => <PageHeader title="Overview" spaced />;
export const ActorsPage = () => <PageHeader title="Actors" spaced />;
export const DeploymentsPage = () => <PageHeader title="Deployments" spaced />;
export const SecretsPage = () => <PageHeader title="Secrets" spaced />;
export const SettingsPage = () => <PageHeader title="Settings" spaced />;
