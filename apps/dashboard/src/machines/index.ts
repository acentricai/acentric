// The Machines section: the machines actors work on, and the sandboxes the engine makes at its
// providers. Only for a person who may manage machines.

import {
  IconCloud,
  IconCloudFilled,
  IconDeviceDesktop,
  IconDeviceDesktopFilled,
} from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { createElement } from 'react';

import { may, type Me } from '../me.ts';
import type { Section } from '../sections.ts';
import { MachinesPage } from './machines.tsx';
import { chosenIn, machinesSearch } from '../url.ts';
import type { MachinesFilter, MachinesSearch } from '../url.ts';
import { ProviderPage, ProvidersPage } from './sandboxes.tsx';

const manages = (me: Me) => may(me, 'machines:manage');

function routes(parent: AnyRoute): AnyRoute[] {
  const machines = createRoute({
    getParentRoute: () => parent,
    path: 'machines',
    validateSearch: machinesSearch,
    component: function Machines() {
      const search = machines.useSearch() as MachinesSearch;
      const navigate = machines.useNavigate();
      const list = (items: readonly string[]) => (items.length === 0 ? undefined : items.join(','));
      return createElement(MachinesPage, {
        types: chosenIn(search, 'type'),
        agents: chosenIn(search, 'agent'),
        actors: chosenIn(search, 'actor'),
        // From the address as it is when the choice is made, not as this page was drawn.
        onToggle: (filter: MachinesFilter, toggled: string) =>
          void navigate({
            search: (before: MachinesSearch) => {
              const now = chosenIn(before, filter);
              const next = now.includes(toggled)
                ? now.filter((each) => each !== toggled)
                : [...now, toggled];
              return { ...before, [filter]: list(next) };
            },
          }),
        onClear: (filter: 'type' | 'agents') =>
          void navigate({
            search: (before: MachinesSearch) =>
              filter === 'type'
                ? { ...before, type: undefined }
                : { ...before, agent: undefined, actor: undefined },
          }),
      });
    },
  });
  const sandboxes = createRoute({
    getParentRoute: () => parent,
    path: 'sandboxes',
    component: ProvidersPage,
  });
  const provider = createRoute({
    getParentRoute: () => parent,
    path: 'sandboxes/$provider',
    component: function Provider() {
      const { provider: providerId } = provider.useParams() as { provider: string };
      return createElement(ProviderPage, { key: providerId, providerId });
    },
  });
  return [machines, sandboxes, provider];
}

export const machinesSection: Section = {
  id: 'machines',
  label: 'Machines',
  tabs: [
    {
      id: 'machines',
      name: 'Machines',
      path: '/machines',
      icon: IconDeviceDesktop,
      activeIcon: IconDeviceDesktopFilled,
      shown: manages,
    },
    {
      id: 'sandboxes',
      name: 'Sandboxes',
      path: '/sandboxes',
      icon: IconCloud,
      activeIcon: IconCloudFilled,
      shown: manages,
    },
  ],
  routes,
};
