// Settings: a tab at the foot of the sidebar, above the account, that opens a large dialog with
// a sidebar of its own: its sections, found by its search, and the page beside it that the one
// chosen shows.

import { IconSettings, IconUser, IconX } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentType } from 'react';

import { AccountSettings } from './SettingsAccount.tsx';

type SettingsSection = {
  readonly id: string;
  readonly name: string;
  readonly icon: Icon;
  readonly page: ComponentType;
};

const SECTIONS: readonly SettingsSection[] = [
  { id: 'account', name: 'Account', icon: IconUser, page: AccountSettings },
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
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const title = useId();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(SECTIONS[0]?.id ?? '');

  useEffect(() => {
    opener.current = document.activeElement;
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    document.body.dataset['dialog'] = 'open';
    return () => {
      delete document.body.dataset['dialog'];
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const found = SECTIONS.filter((section) =>
    section.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const shown = SECTIONS.find((section) => section.id === chosen);
  const Page = shown?.page;

  return (
    <dialog
      ref={ref}
      className="ac-dialog prefs"
      aria-labelledby={title}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A click on the backdrop is a click on the dialog itself, outside its frame.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="prefs__frame">
        <header className="prefs__head">
          <h2 id={title} className="prefs__title">
            Settings
          </h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
            <IconX size={18} stroke={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="prefs__body">
          <nav className="prefs__side" aria-label="Settings">
            <input
              type="search"
              className="prefs__search"
              placeholder="Search"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-autofocus
            />
            <ul className="prefs__list">
              {found.map((section) => {
                const Glyph = section.icon;
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      className="prefs__item"
                      aria-current={section.id === chosen ? 'page' : undefined}
                      onClick={() => setChosen(section.id)}
                    >
                      <Glyph size={17} stroke={1.75} aria-hidden="true" />
                      <span>{section.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {found.length === 0 && <p className="prefs__none">Nothing is called that.</p>}
          </nav>
          <section className="prefs__page" aria-label={shown?.name ?? 'Settings'}>
            {Page !== undefined && <Page />}
          </section>
        </div>
      </div>
    </dialog>
  );
}
