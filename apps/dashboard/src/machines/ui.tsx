// The pieces Machine Pane's pages are made of, drawn with the design system's classes
// (styles/components.css, styles/states.css, and machine-pane.css for what those lack): buttons,
// fields, the page header, statuses, times, copy buttons, tables, menus, dialogs, and the states
// of data being read. Ported from Machine Pane's own dashboard as it was.

import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconDots,
  IconPlus,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';

import { isApiError } from './api.ts';
import { displayText, CopyNotice, safeText } from './text.tsx';
import { fullTime, relative, NOTHING } from './format.ts';
import { usePopover } from '../popover.ts';
import { ErrorToast } from '../ui.tsx';

// Time, kept current

let tick = Date.now();
const ticks = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribeNow(listener: () => void) {
  tick = Date.now();
  ticks.add(listener);
  ticker ??= setInterval(() => {
    tick = Date.now();
    for (const each of ticks) each();
  }, 5_000);
  return () => {
    ticks.delete(listener);
    if (ticks.size === 0 && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/** Now, every five seconds. */
function useNow(): number {
  return useSyncExternalStore(subscribeNow, () => tick);
}

/** `3m ago`, with the full time on hover. */
export function Ago({ at, prefix = '' }: { at: number | null; prefix?: string }) {
  useNow();
  if (at === null) return <span className="ac-table__muted">{NOTHING}</span>;
  return (
    <time className="ac-num" dateTime={new Date(at).toISOString()} title={fullTime(at)}>
      {prefix}
      {relative(at, Date.now())}
    </time>
  );
}

// Buttons

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'lg' | 'md' | 'sm';

/** The class of a button, for a link or a label drawn as one. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `ac-btn ac-btn--${variant}${size === 'lg' ? '' : ` ac-btn--${size}`}`;
}

/**
 * A button in the design system's pill: `primary` is the solid one with the
 * glow under it on hover, `secondary` outlined, `quiet` a wash on hover,
 * `danger` red. `busy` keeps it solid while it works, and disabled.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}) {
  return (
    <button
      {...rest}
      type={type}
      className={`${buttonClass(variant, size)}${className === undefined ? '' : ` ${className}`}`}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}

// Links

/**
 * A link within the dashboard, by its path. This section's routes are made at run time under the
 * shell's `/$org` route, so the router's types do not know their paths.
 */
export function PathLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to as never} {...(className === undefined ? {} : { className })}>
      {children}
    </Link>
  );
}

// Fields

/**
 * A labelled field. `children` gets the control's ID; the control draws
 * itself with `ac-input`.
 */
export function Field({
  label,
  children,
}: {
  label: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="ac-field">
      <label className="ac-field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/** A request's error, in the API's words, as a toast. */
export function FormError({ error }: { error: unknown }) {
  return <ErrorToast error={error}>{displayText(errorText(error))}</ErrorToast>;
}

// Copying

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** True for a moment after `copied()` is called. */
function useCopied(): [boolean, (done: boolean) => void] {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);
  return [done, setDone];
}

/** A copy button: an icon beside an ID, or `Copy` written out. */
export function CopyButton({
  value,
  what,
  text = false,
}: {
  value: string;
  /** For assistive technology: what is copied. */
  what: string;
  text?: boolean;
}) {
  const [done, setDone] = useCopied();
  return (
    <button
      type="button"
      className={text ? buttonClass('secondary', 'sm') : 'icon-button copy-button'}
      aria-label={`Copy ${what}`}
      title={text ? undefined : 'Copy'}
      data-copied={done || undefined}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(value).then(setDone);
      }}
    >
      {done ? (
        <IconCheck size={text ? 13 : 14} stroke={2} aria-hidden="true" />
      ) : (
        <IconCopy size={text ? 13 : 14} stroke={1.75} aria-hidden="true" />
      )}
      {text && 'Copy'}
      <span className="visually-hidden" aria-live="polite">
        {done ? 'Copied' : ''}
      </span>
    </button>
  );
}

/** A command to paste in a terminal, with its copy button. */
export function Command({ text }: { text: string }) {
  return (
    <div className="json command">
      <pre className="json__code" dir="ltr">
        {displayText(text, true)}
      </pre>
      <CopyButton value={text} what="command" />
      <CopyNotice value={text} />
    </div>
  );
}

// Status

/**
 * How a status is drawn: `running` with the glow (a machine is connected),
 * `idle` a hollow dot.
 */
type Tone = 'running' | 'idle';

/** A dot and its word, never a dot alone. */
export function Status({ word, tone }: { word: string; tone: Tone }) {
  return (
    <span className={`ac-status ${tone === 'running' ? 'ac-status--active' : 'ac-status--idle'}`}>
      <span className="ac-status__dot" aria-hidden="true" />
      {displayText(word)}
    </span>
  );
}

// Tables

type Column<T> = {
  readonly name: string;
  readonly cell: (row: T) => ReactNode;
  /** The heading is for assistive technology only, such as a column of row menus. */
  readonly hidden?: boolean;
  /** `ac-table__actions` holds a row's menu at its right end. */
  readonly className?: string;
};

/**
 * A table of one kind of thing. While nothing is read it keeps its headings
 * and shimmers its rows. A narrow screen scrolls the table sideways.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  loading,
  label,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string;
  loading: boolean;
  label: string;
}) {
  return (
    <div className="ac-table-wrap">
      <table className="ac-table" aria-label={label} aria-busy={loading}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name} scope="col" className={column.className}>
                {column.hidden ? (
                  <span className="visually-hidden">{column.name}</span>
                ) : (
                  column.name
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === undefined
            ? Array.from({ length: loading ? 6 : 0 }, (_, i) => (
                <tr key={i} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.name} className={column.className}>
                      {!column.hidden && <span className="skeleton__line cell-skeleton" />}
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((column) => (
                    <td key={column.name} data-label={column.name} className={column.className}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

// States of data

export const NOT_FOUND = 'Nothing here.';

/** Where the data would be: why it is not, in the API's words, with `Retry`. */
export function LoadError({
  error,
  things,
  onRetry,
  compact = false,
  retrying = false,
}: {
  error: unknown;
  things: string;
  onRetry: () => void;
  compact?: boolean;
  retrying?: boolean;
}) {
  const missing = isApiError(error, 404);
  return (
    <div className={compact ? 'state-error state-error--compact' : 'state-error'} role="alert">
      <IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />
      <div>
        <p className="state-error__title">{missing ? NOT_FOUND : `Couldn’t load ${things}.`}</p>
        {!missing && <p className="note">{displayText(errorText(error))}</p>}
        {retrying && (
          <p role="status" className="note">
            Retrying…
          </p>
        )}
      </div>
      {!missing && (
        <Button size="sm" variant="secondary" busy={retrying} onClick={onRetry}>
          <IconRefresh size={14} stroke={1.75} aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  );
}

// The page's header

/** A page's name and, at its right, the page's actions. It rises in on load. */
export function PageHeader({
  title,
  children,
  spaced = false,
}: {
  title: ReactNode;
  /** The page's actions: buttons, a menu. */
  children?: ReactNode;
  /** Keeps 64px under a header with nothing between it and the content. */
  spaced?: boolean;
}) {
  return (
    <header className={spaced ? 'page__head page__head--spaced rise' : 'page__head rise'}>
      <h1 className="page__title">{typeof title === 'string' ? displayText(title) : title}</h1>
      {children != null && <div className="page__actions">{children}</div>}
    </header>
  );
}

// Menus

/** The arrow keys, Home and End move through a menu's items. */
function moveInMenu(event: ReactKeyboardEvent, list: HTMLElement | null) {
  const items = [
    ...(list?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []),
  ];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to =
    event.key === 'ArrowDown'
      ? (at + 1) % items.length
      : event.key === 'ArrowUp'
        ? (at - 1 + items.length) % items.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : null;
  if (to === null) return;
  event.preventDefault();
  items[to]?.focus();
}

/** Where the open menu sits: under its button, right edges aligned. */
type Place = { top: number; right: number };
function placeUnder(button: HTMLElement | null): Place | null {
  if (button === null) return null;
  const box = button.getBoundingClientRect();
  return {
    top: box.bottom + 6,
    right: document.documentElement.clientWidth - box.right,
  };
}

/**
 * The round `⋯` button that opens a menu of `MenuItem`s, in the app's popover
 * panel. The panel is drawn over the page, outside any scrolling table, and
 * follows its button when the page scrolls or resizes. Opening focuses the
 * first item; the arrow keys, Home and End move through the items. Escape or
 * a press outside closes it and focus goes back to the button; Tab closes it
 * and moves on from the button.
 */
export function Menu({
  label,
  children,
}: {
  /** Names the button and the menu, such as `Actions for Studio`. */
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const menu = usePopover();
  const id = useId();
  const [place, setPlace] = useState<Place | null>(null);
  const open = () => {
    setPlace(placeUnder(menu.trigger.current));
    menu.setOpen(true);
  };

  useEffect(() => {
    if (!menu.open) return;
    menu.popup.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const follow = () => setPlace(placeUnder(menu.trigger.current));
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [menu.open, menu.popup, menu.trigger]);

  return (
    <div className="more-menu" ref={menu.container}>
      <button
        ref={menu.trigger}
        type="button"
        className={`${buttonClass('quiet', 'md')} more-menu__button`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? id : undefined}
        aria-label={label}
        onClick={() => (menu.open ? menu.setOpen(false) : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open();
          }
        }}
      >
        <IconDots size={16} stroke={1.75} aria-hidden="true" />
      </button>
      {menu.open &&
        place !== null &&
        createPortal(
          <div
            ref={menu.popup}
            id={id}
            role="menu"
            aria-label={label}
            className="pop more-menu__pop more-menu__pop--placed"
            style={{ top: place.top, right: place.right }}
            onKeyDown={(event) => {
              if (event.key === 'Tab') menu.close();
              else moveInMenu(event, menu.popup.current);
            }}
          >
            {children(menu.close)}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** An item of a menu; `danger` reads red. */
export function MenuItem({
  children,
  onSelect,
  icon,
  danger = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  icon: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`pop__item${danger ? ' pop__item--danger' : ''}`}
      onClick={onSelect}
    >
      {icon}
      <span className="pop__text">{children}</span>
    </button>
  );
}

// Dialogs

/**
 * A modal dialog: the page behind is inert, the close button, Escape and
 * `Cancel` close it, and focus goes back to what opened it. `footer` holds
 * its buttons, at its foot on the right.
 */
export type Choice = { readonly value: string; readonly label: string };

/**
 * A filter as a chip: dashed with `+` and the filter's name while nothing is chosen; once
 * something is, the name, what is chosen (its name, or how many), and a button at its start that
 * clears it. It opens `children` in a list under it, which stays open while choices are made, and
 * `aside` beside that list.
 */
export function FilterPill({
  name,
  labels,
  onClear,
  onClose,
  children,
  aside,
}: {
  name: string;
  /** What is chosen, by name. */
  labels: readonly string[];
  onClear: () => void;
  /** When the list is closed. */
  onClose?: () => void;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const popover = usePopover();
  const id = useId();
  const value =
    labels.length === 0
      ? undefined
      : labels.length === 1
        ? (labels[0] ?? '')
        : `${String(labels.length)} selected`;
  const closed = useRef(onClose);
  useEffect(() => {
    closed.current = onClose;
  });
  useEffect(() => {
    if (!popover.open) closed.current?.();
  }, [popover.open]);
  return (
    <div
      className="filter-chip"
      ref={popover.container}
      onKeyDown={(event) => {
        if (!popover.open || event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        popover.close();
      }}
    >
      <span className="filter-chip__pill" data-set={value !== undefined || undefined}>
        {value !== undefined && (
          <button
            type="button"
            className="filter-chip__clear"
            aria-label={`Clear ${name}`}
            onClick={() => {
              popover.close();
              onClear();
            }}
          >
            <IconX size={12} stroke={2} aria-hidden="true" />
          </button>
        )}
        <button
          ref={popover.trigger}
          type="button"
          className="filter-chip__button"
          aria-expanded={popover.open}
          aria-controls={popover.open ? id : undefined}
          aria-label={labels.length === 0 ? name : `${name}: ${safeText(labels.join(', '))}`}
          onClick={() => popover.setOpen((open) => !open)}
        >
          {value === undefined && <IconPlus size={13} stroke={1.75} aria-hidden="true" />}
          {name}
          {value !== undefined && (
            <>
              <span className="filter-chip__rule" aria-hidden="true" />
              <span className="filter-chip__value">{displayText(value)}</span>
            </>
          )}
        </button>
      </span>
      {popover.open && (
        <div id={id} role="group" aria-label={name} className="pop filter-chip__pop">
          {children}
        </div>
      )}
      {popover.open && aside}
    </div>
  );
}

/** One choice of a filter's list: a checkbox and its name. */
export function FilterOption({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="filter-chip__option" data-on={on || undefined}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span>{displayText(label)}</span>
    </label>
  );
}

/**
 * A filter of several choices, each with a checkbox. A choice made is told as the one choice
 * that changed, so that two made before the page is drawn again are both kept.
 */
export function FilterChip({
  name,
  choices,
  chosen,
  onToggle,
  onClear,
}: {
  name: string;
  choices: readonly Choice[];
  chosen: readonly string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const labels = choices
    .filter((choice) => chosen.includes(choice.value))
    .map((choice) => choice.label);
  return (
    <FilterPill name={name} labels={labels} onClear={onClear}>
      {choices.map((choice) => (
        <FilterOption
          key={choice.value}
          label={choice.label}
          on={chosen.includes(choice.value)}
          onToggle={() => onToggle(choice.value)}
        />
      ))}
      {choices.length === 0 && <p className="filter-chip__none">Nothing to choose from.</p>}
    </FilterPill>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
  pending = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  pending?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  useEffect(() => {
    opener.current = document.activeElement;
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const target =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>('input:not([readonly]), select, textarea');
    if (target !== null && target !== undefined) target.focus();
    else dialog?.focus();
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
      className={wide ? 'ac-dialog dialog dialog--wide' : 'ac-dialog dialog'}
      aria-labelledby={id}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!pending) onClose();
        }
        if (event.key === 'Tab') {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true');
          const first = controls[0],
            last = controls.at(-1);
          if (controls.length === 0) {
            event.preventDefault();
            event.currentTarget.focus();
          } else if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="dialog__head">
        <h2 id={id} className="ac-dialog__title">
          {typeof title === 'string' ? displayText(title) : title}
        </h2>
        <button
          type="button"
          className="dialog__close"
          disabled={pending}
          onClick={() => {
            if (!pending) onClose();
          }}
          aria-label="Close"
        >
          <IconX size={16} stroke={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="dialog__body">{children}</div>
      {footer != null && <div className="ac-dialog__actions">{footer}</div>}
    </dialog>
  );
}

/** A confirmation: one sentence, `Cancel`, and the action. */
export function Confirm({
  title,
  sentence,
  action,
  onConfirm,
  onClose,
  pending,
  error,
  danger = false,
}: {
  title: string;
  sentence: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error?: string | null | undefined;
  /** Draws the action red: for what cannot be undone. */
  danger?: boolean;
}) {
  return (
    <Dialog
      title={title}
      pending={pending}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={pending} onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={pending} onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      <p className="ac-dialog__body">{displayText(sentence)}</p>
      <ErrorToast error={error}>
        {typeof error === 'string' ? displayText(error) : error}
      </ErrorToast>
    </Dialog>
  );
}

/**
 * The message of an error, as the API gave it: for a request it refused as not what it takes,
 * what is wrong with it, such as a name that is not one.
 */
export function errorText(error: unknown): string {
  if (isApiError(error, 400, 'invalid_request')) {
    const issue = error.issues?.find((each) => each.message !== '');
    if (issue !== undefined) return issue.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
