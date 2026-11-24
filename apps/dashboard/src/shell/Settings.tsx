// Settings: a tab at the foot of the sidebar, above the account, that opens a large dialog with
// a sidebar of its own. It has no sections yet: its sidebar is where they will be listed, found
// by its search, and the page beside it what the one chosen shows.

import { IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';

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

  return (
    <dialog
      ref={ref}
      className="ac-dialog settings"
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
      <div className="settings__frame">
        <header className="settings__head">
          <h2 id={title} className="settings__title">
            Settings
          </h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
            <IconX size={18} stroke={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="settings__body">
          <nav className="settings__side" aria-label="Settings">
            <label className="settings__search">
              <IconSearch size={16} stroke={1.75} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search"
                aria-label="Search settings"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-autofocus
              />
            </label>
            <ul className="settings__list" />
          </nav>
          <section className="settings__page" aria-label="Settings page" />
        </div>
      </div>
    </dialog>
  );
}
