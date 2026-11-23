// The Engine section: the engine's own pages. API keys, for a person who may make keys; the
// people of the engine and their invites, for one who may manage people; the server's backups,
// for one who may manage them; and the audit log, for one who may read it.

import {
  IconDatabase,
  IconDatabaseFilled,
  IconKey,
  IconKeyFilled,
  IconListDetails,
  IconListDetailsFilled,
  IconUser,
  IconUserFilled,
} from '@tabler/icons-react';
import { createRoute, type AnyRoute } from '@tanstack/react-router';
import { createElement } from 'react';

import { may } from '../me.ts';
import type { Section } from '../sections.ts';
import { AuditPage } from './audit.tsx';
import { BackupsPage } from './backups.tsx';
import { KeysPage } from './keys.tsx';
import { PeoplePage } from './people.tsx';
import { auditSearch, type AuditSearch } from './url.ts';

function routes(parent: AnyRoute): AnyRoute[] {
  const audit = createRoute({
    getParentRoute: () => parent,
    path: 'audit',
    validateSearch: auditSearch,
    component: function Audit() {
      const { action } = audit.useSearch() as AuditSearch;
      const navigate = audit.useNavigate();
      return createElement(AuditPage, {
        action,
        onAction: (chosen: string | undefined) => void navigate({ search: { action: chosen } }),
      });
    },
  });
  return [
    createRoute({ getParentRoute: () => parent, path: 'keys', component: KeysPage }),
    createRoute({ getParentRoute: () => parent, path: 'people', component: PeoplePage }),
    createRoute({ getParentRoute: () => parent, path: 'backups', component: BackupsPage }),
    audit,
  ];
}

export const engineSection: Section = {
  id: 'engine',
  label: 'Engine',
  tabs: [
    {
      id: 'keys',
      name: 'API keys',
      path: '/keys',
      icon: IconKey,
      activeIcon: IconKeyFilled,
      shown: (me) => may(me, 'keys:manage'),
    },
    {
      id: 'people',
      name: 'People',
      path: '/people',
      icon: IconUser,
      activeIcon: IconUserFilled,
      shown: (me) => may(me, 'users:manage'),
    },
    {
      id: 'backups',
      name: 'Backups',
      path: '/backups',
      icon: IconDatabase,
      activeIcon: IconDatabaseFilled,
      shown: (me) => may(me, 'backups:manage'),
    },
    {
      id: 'audit',
      name: 'Audit log',
      path: '/audit',
      icon: IconListDetails,
      activeIcon: IconListDetailsFilled,
      shown: (me) => may(me, 'audit:read'),
    },
  ],
  routes,
};
