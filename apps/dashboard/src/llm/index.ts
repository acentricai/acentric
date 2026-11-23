// The LLM providers section: the accounts model calls are made with, and what the calls cost.
// Accounts are for a person who may manage them; usage for one who may read it.

import {
  IconChartBar,
  IconChartBarPopular,
  IconSparkles,
  IconSparklesFilled,
} from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { AccountsPage } from './accounts.tsx';
import { UsagePage } from './usage.tsx';

function routes(parent: AnyRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => parent, path: 'llm-providers', component: AccountsPage }),
    createRoute({ getParentRoute: () => parent, path: 'usage', component: UsagePage }),
  ];
}

export const llmSection: Section = {
  id: 'llm',
  label: 'LLM providers',
  tabs: [
    {
      id: 'accounts',
      name: 'Accounts',
      path: '/llm-providers',
      icon: IconSparkles,
      activeIcon: IconSparklesFilled,
      shown: (me) => may(me, 'accounts:manage'),
    },
    {
      id: 'usage',
      name: 'Usage',
      path: '/usage',
      icon: IconChartBar,
      activeIcon: IconChartBarPopular,
      shown: (me) => may(me, 'usage:read'),
    },
  ],
  routes,
};
