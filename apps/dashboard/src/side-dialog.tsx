// A large dialog with a sidebar of its own: its tabs, and the page beside it that the one chosen
// shows. Settings is one; a deployment's is another.

import { IconX } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

export type SideTab = { readonly id: string; readonly name: string; readonly icon: Icon };

export function SideDialog({
  title,
  label,
  tabs,
  chosen,
  onChoose,
  onClose,
  children,
}: {
  title: ReactNode;
  /** Names the sidebar for assistive technology. */
  label: string;
  tabs: readonly SideTab[];
  chosen: string;
  onChoose: (id: string) => void;
  onClose: () => void;
  /** The chosen tab's page. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    opener.current = document.activeElement;
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    dialog?.querySelector<HTMLElement>('.prefs__item[aria-current="page"]')?.focus();
    document.body.dataset['dialog'] = 'open';
    return () => {
      delete document.body.dataset['dialog'];
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const shown = tabs.find((tab) => tab.id === chosen) ?? tabs[0];

  return (
    <dialog
      ref={ref}
      className="ac-dialog prefs"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        // A file picker that was cancelled says so with a cancel of its own, which comes up
        // here: only the dialog's own, as Escape, closes it.
        if (event.target !== event.currentTarget) return;
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
          <h2 id={titleId} className="prefs__title">
            {title}
          </h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
            <IconX size={18} stroke={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="prefs__body">
          <nav className="prefs__side" aria-label={label}>
            <ul className="prefs__list">
              {tabs.map((tab) => {
                const Glyph = tab.icon;
                return (
                  <li key={tab.id}>
                    <button
                      type="button"
                      className="prefs__item"
                      aria-current={tab.id === shown?.id ? 'page' : undefined}
                      onClick={() => onChoose(tab.id)}
                    >
                      <Glyph size={17} stroke={1.75} aria-hidden="true" />
                      <span>{tab.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section className="prefs__page" aria-label={shown?.name ?? label}>
            {children}
          </section>
        </div>
      </div>
    </dialog>
  );
}
