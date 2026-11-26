// Settings: a tab at the foot of the sidebar, above the account, that opens a large dialog with
// a sidebar of its own: its sections, and the page beside it that the one chosen shows.

import {
  IconDatabase,
  IconKey,
  IconListDetails,
  IconRefresh,
  IconSettings,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { useState } from 'react';
import type { ComponentType } from 'react';

import { may, useMe, type Me } from '../me.ts';
import { SideDialog } from '../side-dialog.tsx';
import { AccountSettings } from './SettingsAccount.tsx';
import { AuditSettings } from './SettingsAudit.tsx';
import { BackupsSettings } from './SettingsBackups.tsx';
import { KeysSettings } from './SettingsKeys.tsx';
import { PeopleSettings } from './SettingsPeople.tsx';
import { UpdatesSettings } from './SettingsUpdates.tsx';

type SettingsSection = {
  readonly id: string;
  readonly name: string;
  readonly icon: Icon;
  readonly page: ComponentType;
  /** Whether a person sees it: everyone, without it. */
  readonly shown?: (me: Me) => boolean;
};

const SECTIONS: readonly SettingsSection[] = [
  { id: 'account', name: 'Account', icon: IconUserCircle, page: AccountSettings },
  {
    id: 'people',
    name: 'People',
    icon: IconUsers,
    page: PeopleSettings,
    shown: (me) => may(me, 'users:manage'),
  },
  {
    id: 'keys',
    name: 'API keys',
    icon: IconKey,
    page: KeysSettings,
    shown: (me) => may(me, 'keys:manage'),
  },
  {
    id: 'backups',
    name: 'Backups',
    icon: IconDatabase,
    page: BackupsSettings,
    shown: (me) => may(me, 'backups:manage'),
  },
  {
    id: 'audit',
    name: 'Audit log',
    icon: IconListDetails,
    page: AuditSettings,
    shown: (me) => may(me, 'audit:read'),
  },
  {
    id: 'updates',
    name: 'Updates',
    icon: IconRefresh,
    page: UpdatesSettings,
    // For whoever runs the server: one who may manage its backups.
    shown: (me) => may(me, 'backups:manage'),
  },
];

export function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="side__settings">
      <button
        type="button"
        className="nav__link side__settings-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Settings"
        title={collapsed ? 'Settings' : undefined}
        onClick={() => setOpen(true)}
      >
        <span className="nav__icon">
          <IconSettings size={18} stroke={1.75} aria-hidden="true" />
        </span>
        <span className="nav__text">Settings</span>
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const sections = SECTIONS.filter(
    (section) => section.shown === undefined || (me.data !== undefined && section.shown(me.data)),
  );
  const [chosen, setChosen] = useState(SECTIONS[0]?.id ?? '');
  const Page = (sections.find((section) => section.id === chosen) ?? sections[0])?.page;
  return (
    <SideDialog
      title="Settings"
      label="Settings"
      tabs={sections}
      chosen={chosen}
      onChoose={setChosen}
      onClose={onClose}
    >
      {Page !== undefined && <Page />}
    </SideDialog>
  );
}
