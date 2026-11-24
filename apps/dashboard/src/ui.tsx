// The pieces every page is made of, drawn with the reference dashboard's
// classes (styles/components.css, styles/states.css): buttons, fields, the
// page header and tabs, IDs, statuses, times, copy buttons, tables, menus,
// dialogs, and the states of data being read. As basic-harness has it.

import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconInfoCircle,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { Link, useLocation, type LinkOptions } from '@tanstack/react-router';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { boundedJson } from './json-text.ts';
import {
  firstBytes,
  byteLength,
  fullTime,
  relative,
  shortId,
  size as sizeText,
  NOTHING,
} from './format.ts';
import { usePopover } from './popover.ts';
import { errorText, isApiError } from './api.ts';
import { NOT_FOUND } from './shell/NotFound.tsx';

export { NOT_FOUND, NotFound } from './shell/NotFound.tsx';

// Time, kept current

let tick = Date.now();
const ticks = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function subscribeNow(listener: () => void) {
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
export function useNow(): number {
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

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'sm';

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

// Fields

/**
 * A labelled field. `children` gets the control's ID; the control draws
 * itself with `ac-input` (`ac-input--md`, `ac-input--mono`).
 */
export function Field({
  label,
  optional = false,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="ac-field">
      <label className="ac-field__label" htmlFor={id}>
        {label}
        {optional && <span className="ac-field__optional"> optional</span>}
      </label>
      {children(id)}
      {hint != null && <span className="ac-field__hint">{hint}</span>}
      {error != null && error !== false && (
        <p className="ac-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** An inline error under a form or in a dialog, in the API's words. */
export function FormError({ error }: { error: unknown }) {
  if (error === null || error === undefined || error === false) return null;
  return (
    <p className="ac-field__error form-error" role="alert">
      {errorText(error)}
    </p>
  );
}

// Copying

export async function copyText(text: string): Promise<boolean> {
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

/** A small chevron: down for a menu or an open band, right for a closed one. */
export const Chevron = ({ open = true }: { open?: boolean }) =>
  open ? (
    <IconChevronDown className="chevron-glyph" size={14} stroke={1.75} aria-hidden="true" />
  ) : (
    <IconChevronRight className="chevron-glyph" size={14} stroke={1.75} aria-hidden="true" />
  );

/** A copy button: an icon beside an ID, or `Copy` written out. */
export function CopyButton({
  value,
  what,
  text = false,
  label,
}: {
  value: string;
  /** For assistive technology: what is copied. */
  what: string;
  text?: boolean;
  /** A full-size button with these words, as a dialog's footer has. */
  label?: string;
}) {
  const [done, setDone] = useCopied();
  return (
    <button
      type="button"
      className={
        label !== undefined
          ? buttonClass('secondary')
          : text
            ? buttonClass('secondary', 'sm')
            : 'icon-button copy-button'
      }
      aria-label={label ?? `Copy ${what}`}
      title={text ? undefined : 'Copy'}
      data-copied={done || undefined}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(value).then(setDone);
      }}
    >
      {done ? (
        <IconCheck size={label !== undefined ? 15 : text ? 13 : 14} stroke={2} aria-hidden="true" />
      ) : (
        <IconCopy
          size={label !== undefined ? 15 : text ? 13 : 14}
          stroke={1.75}
          aria-hidden="true"
        />
      )}
      {label ?? (text && 'Copy')}
      <span className="visually-hidden" aria-live="polite">
        {done ? 'Copied' : ''}
      </span>
    </button>
  );
}

/** An ID: mono in its pill, cut in the middle when long, whole on hover. */
export function Id({ value, max = 20 }: { value: string; max?: number }) {
  const short = shortId(value, max);
  return (
    <span className="ac-id ac-id--plain">
      <span className="ac-id__text" title={short === value ? undefined : value}>
        {short}
      </span>
    </span>
  );
}

/** An ID with its copy button inside the pill. */
export function CopyId({ value, max, label }: { value: string; max?: number; label?: string }) {
  const [done, setDone] = useCopied();
  const short = shortId(value, max);
  return (
    <span className="ac-id" data-copied={done || undefined}>
      <span className="ac-id__text" title={short === value ? undefined : value}>
        {short}
      </span>
      <button
        type="button"
        className="ac-id__copy"
        aria-label={`Copy ${label ?? value}`}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          void copyText(value).then(setDone);
        }}
      >
        {done ? (
          <IconCheck size={13} stroke={2} aria-hidden="true" />
        ) : (
          <IconCopy size={13} stroke={1.75} aria-hidden="true" />
        )}
        <span className="visually-hidden" aria-live="polite">
          {done ? 'Copied' : ''}
        </span>
      </button>
    </span>
  );
}

/** A command to paste in a terminal, with its copy button. */
export function Command({ text }: { text: string }) {
  return (
    <div className="json command">
      <pre className="json__code">{text}</pre>
      <CopyButton value={text} what="command" />
    </div>
  );
}

// Status

/**
 * How a status is drawn: `running` with the glow (an agent is working now),
 * `idle` a hollow dot, `closed` a hairline dot, `waiting` and `failed` filled
 * pills, `plain` a quiet dot.
 */
export type Tone = 'running' | 'failed' | 'waiting' | 'idle' | 'closed' | 'plain';

export function toneOf(status: string): Tone {
  if (status === 'running') return 'running';
  if (status === 'failed' || status.startsWith('failed')) return 'failed';
  if (status === 'queued') return 'waiting';
  if (status === 'idle') return 'idle';
  if (status === 'terminated' || status === 'aborted' || status === 'ended') return 'closed';
  return 'plain';
}

const STATUS_CLASS: Record<Tone, string> = {
  running: 'ac-status--active',
  failed: 'ac-status--failed',
  waiting: 'ac-status--blocked',
  idle: 'ac-status--idle',
  closed: 'ac-status--closed',
  plain: '',
};

/** A dot and its word, never a dot alone. */
export function Status({
  word,
  tone,
  tiny = false,
}: {
  word: string;
  tone?: Tone;
  tiny?: boolean;
}) {
  const t = tone ?? toneOf(word);
  return (
    <span className={`ac-status ${STATUS_CLASS[t]}${tiny ? ' ac-status--tiny' : ''}`}>
      <span className="ac-status__dot" aria-hidden="true" />
      {word}
    </span>
  );
}

/** A small label: `latest`, `pinned`, a role, an input type. `live` is the solid one. */
export function Label({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return <span className={live ? 'tag tag--live' : 'tag'}>{children}</span>;
}

// Tables

export type Column<T> = {
  readonly name: string;
  readonly cell: (row: T) => ReactNode;
  /** `ac-table__num` aligns a number to the right; `ac-table__muted` greys a cell. */
  readonly className?: string;
  /** Its heading is for screen readers only, as a row's menu's is. */
  readonly hidden?: boolean;
};

/**
 * A table of one kind of thing. While nothing is read it keeps its headings
 * and shimmers its rows. A row with `onRow` is a link-like row; a narrow
 * screen scrolls the table sideways.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  loading,
  label,
  onRow,
  expanded,
  detail,
  className,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string;
  loading: boolean;
  label: string;
  onRow?: (row: T) => void;
  expanded?: (row: T) => boolean;
  detail?: (row: T) => ReactNode;
  className?: string;
}) {
  return (
    <div className="ac-table-wrap">
      <table
        className={className === undefined ? 'ac-table' : `ac-table ${className}`}
        aria-label={label}
        aria-busy={loading}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name} scope="col" className={column.className}>
                {column.hidden === true ? (
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
                      <span className="skeleton__line cell-skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.flatMap((row) => {
                const open = expanded?.(row) ?? false;
                const key = rowKey(row);
                const line = (
                  <tr
                    key={key}
                    data-href={onRow === undefined ? undefined : ''}
                    aria-expanded={expanded === undefined ? undefined : open}
                    onClick={(event) => {
                      if (onRow === undefined) return;
                      const target = event.target as HTMLElement;
                      if (target.closest('a, button, input, select, textarea') !== null) return;
                      onRow(row);
                    }}
                  >
                    {columns.map((column) => (
                      <td key={column.name} data-label={column.name} className={column.className}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
                if (!open || detail === undefined) return [line];
                return [
                  line,
                  <tr key={`${key}-detail`} className="detail-row">
                    <td colSpan={columns.length}>{detail(row)}</td>
                  </tr>,
                ];
              })}
        </tbody>
      </table>
    </div>
  );
}

// States of data

/** Where the data would be: why it is not, in the API's words, with `Retry`. */
export function LoadError({
  error,
  things,
  onRetry,
  compact = false,
}: {
  error: unknown;
  things: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const missing = isApiError(error, 404);
  return (
    <div className={compact ? 'state-error state-error--compact' : 'state-error'} role="alert">
      <IconAlertTriangle size={18} stroke={1.75} aria-hidden="true" />
      <div>
        <p className="state-error__title">{missing ? NOT_FOUND : `Couldn’t load ${things}.`}</p>
        {!missing && <p className="note">{errorText(error)}</p>}
      </div>
      {!missing && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <IconRefresh size={14} stroke={1.75} aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  );
}

/** Nothing yet: what is empty (`No agents`), and what makes the first one. */
export function Empty({
  title,
  children,
  action,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state-empty">
      {title !== undefined && <p className="state-empty__title">{title}</p>}
      {children}
      {action}
    </div>
  );
}

/** Placeholder lines while data loads: the shape of what's coming, quietly shimmering. */
export function Skeleton({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton__line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** A page-sized placeholder: the title's place and a few lines. It sits inside the shell's page. */
export function PageSkeleton() {
  return (
    <div aria-busy="true">
      <span className="skeleton__title" />
      <Skeleton rows={6} />
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger';
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Glyph = tone === 'info' ? IconInfoCircle : IconAlertTriangle;
  return (
    <div
      className={`ac-notice ${tone === 'info' ? '' : `ac-notice--${tone}`} notice-in`}
      role="status"
    >
      <Glyph className="ac-icon" size={16} stroke={1.75} aria-hidden="true" />
      <div>
        <p className="ac-notice__title">{title}</p>
        {children != null && <div className="ac-notice__body">{children}</div>}
      </div>
      {action != null && <div className="ac-notice__action">{action}</div>}
    </div>
  );
}

/** `Newer` and `Older`, for a list of more than one page. */
export function Pager({
  newer,
  older,
}: {
  newer: (() => void) | null;
  older: (() => void) | null;
}) {
  if (newer === null && older === null) return null;
  return (
    <nav className="table-more" aria-label="Pages">
      <Button variant="quiet" disabled={newer === null} onClick={() => newer?.()}>
        Newer
      </Button>
      <Button variant="quiet" disabled={older === null} onClick={() => older?.()}>
        Older
      </Button>
    </nav>
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
      <h1 className="page__title">{title}</h1>
      {children != null && <div className="page__actions">{children}</div>}
    </header>
  );
}

export type Crumb = { readonly label: string; readonly to?: string; readonly id?: boolean };

/**
 * The old title line, kept so pages keep working: the path is now in the top
 * bar's breadcrumbs, so this draws the last part as the page's header (an ID
 * in mono with its copy button) and `children` as its actions. New pages use
 * `PageHeader`.
 */
export function Title({ crumbs, children }: { crumbs: readonly Crumb[]; children?: ReactNode }) {
  const last = crumbs.at(-1);
  if (last === undefined) return null;
  return (
    <PageHeader title={last.id === true ? <CopyId value={last.label} max={28} /> : last.label}>
      {children}
    </PageHeader>
  );
}

// Tabs within a page

export type TabLink = { name: string; count?: number; link: LinkOptions };

/**
 * Tabs within a page, as links, with an underline that slides to the current
 * one. A tab that is a prefix of another (an index tab) passes
 * `activeOptions: { exact: true }` in its link.
 */
export function PageTabs({ tabs, label }: { tabs: ReadonlyArray<TabLink>; label: string }) {
  const nav = useRef<HTMLElement>(null);
  const [line, setLine] = useState<{ x: number; w: number } | null>(null);
  const pathname = useLocation({ select: (l) => l.pathname });
  const signature = tabs.map((t) => `${t.name}${t.count ?? ''}`).join('|');

  // Measured after the route or the labels change, and on resize. Only a real
  // move updates state, so measuring never loops.
  useLayoutEffect(() => {
    const place = () => {
      const current = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current || !nav.current) return setLine(null);
      const root = nav.current.getBoundingClientRect();
      const box = current.getBoundingClientRect();
      const next = { x: box.left - root.left + nav.current.scrollLeft, w: box.width };
      setLine((prev) => (prev && prev.x === next.x && prev.w === next.w ? prev : next));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    if (nav.current) observer.observe(nav.current);
    return () => observer.disconnect();
  }, [pathname, signature]);

  return (
    <nav className="tabs" aria-label={label} ref={nav}>
      {tabs.map((tab) => (
        <Link key={tab.name} {...tab.link} className="tabs__tab">
          {tab.name}
          {tab.count != null && <span className="tabs__count">{tab.count}</span>}
        </Link>
      ))}
      {line && (
        <span
          className="tabs__line"
          style={{ transform: `translateX(${line.x}px)`, width: line.w }}
          aria-hidden="true"
        />
      )}
    </nav>
  );
}

/** One choice of a few, with a thumb that slides between them. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, ReactNode]>;
  onChange: (value: T) => void;
}) {
  const index = options.findIndex(([v]) => v === value);
  return (
    <div className="seg-scroll">
      <div
        className="seg"
        role="radiogroup"
        aria-label={label}
        style={{ '--seg-i': index, '--seg-n': options.length } as CSSProperties}
      >
        <span className="seg__thumb" aria-hidden="true" />
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            className="seg__option"
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

// Menus

/** The arrow keys, Home and End move through a menu's items. */
function moveInMenu(event: ReactKeyboardEvent, list: HTMLElement | null) {
  const items = [
    ...(list?.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not([disabled]), a[role^="menuitem"]',
    ) ?? []),
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

/**
 * A button that opens a menu of `MenuItem`s, in the app's popover panel.
 * `field` draws the button as the dropdown pill (a filter, a choice); `more`
 * as the round `⋯` button. Escape or a press outside closes it and focus goes
 * back; the arrow keys move through the items.
 */
export function Menu({
  label,
  button,
  children,
  align = 'start',
  variant = 'field',
  className,
}: {
  label: string;
  /** What the button shows; `more` defaults to `⋯`. */
  button?: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  variant?: 'field' | 'more';
  className?: string;
}) {
  const menu = usePopover();
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  // Opening lands on the checked item, else the first, so the arrow keys start there.
  useEffect(() => {
    if (!menu.open) return;
    const items = [
      ...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []),
    ];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [menu.open]);

  return (
    <div
      className={`${align === 'end' ? 'more-menu' : 'dropdown'}${className === undefined ? '' : ` ${className}`}`}
      ref={menu.container}
      onKeyDown={(event) => {
        if (!menu.open || event.key !== 'Escape') return;
        // A menu inside a dialog closes alone.
        event.stopPropagation();
        event.preventDefault();
        menu.close();
      }}
    >
      <button
        ref={menu.trigger}
        type="button"
        className={
          variant === 'more'
            ? `${buttonClass('secondary', 'md')} more-menu__button`
            : 'dropdown__button'
        }
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? id : undefined}
        aria-label={label}
        onClick={() => menu.setOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            menu.setOpen(true);
          }
        }}
      >
        {button ??
          (variant === 'more' ? <IconDots size={16} stroke={1.75} aria-hidden="true" /> : null)}
      </button>
      {menu.open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={align === 'end' ? 'pop more-menu__pop' : 'pop dropdown__pop'}
          onKeyDown={(event) => moveInMenu(event, list.current)}
        >
          {children(menu.close)}
        </div>
      )}
    </div>
  );
}

/**
 * An item of a menu. `checked` makes it one of a choice (a check at its
 * right); `danger` reads red.
 */
export function MenuItem({
  children,
  onSelect,
  icon,
  checked,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const choice = checked !== undefined;
  return (
    <button
      type="button"
      role={choice ? 'menuitemradio' : 'menuitem'}
      aria-checked={choice ? checked : undefined}
      className={`pop__item${choice ? ' dropdown__item' : ''}${danger ? ' pop__item--danger' : ''}`}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span className="pop__text">{children}</span>
      {choice && (
        <span className="dropdown__check">
          {checked && <IconCheck size={14} stroke={2} aria-hidden="true" />}
        </span>
      )}
    </button>
  );
}

export function MenuRule() {
  return <div className="pop__rule" role="separator" />;
}

export type DropdownOption<T extends string> = { value: T; label: string };

/**
 * A single choice in the site's own style: a pill button showing the current
 * choice, opening the popover list instead of the browser's native menu.
 */
export function Dropdown<T extends string>({
  value,
  options,
  label,
  onChange,
  placeholder,
  empty,
}: {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  /** What the choice is, for assistive technology. */
  label: string;
  onChange: (value: T) => void;
  /** What it shows while none of the options is chosen. */
  placeholder?: string;
  /** What it says when there is nothing to choose: it then opens no list. */
  empty?: string;
}) {
  const current = options.find((option) => option.value === value);
  if (options.length === 0 && empty !== undefined && placeholder !== 'Loading…') {
    return (
      <div className="dropdown">
        <button
          type="button"
          className="dropdown__button"
          disabled
          aria-label={`${label}: ${empty}`}
        >
          <span className="dropdown__value dropdown__value--none">{empty}</span>
          <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <Menu
      label={`${label}: ${current?.label ?? placeholder ?? ''}`}
      button={
        <>
          <span
            className={
              current === undefined ? 'dropdown__value dropdown__value--none' : 'dropdown__value'
            }
          >
            {current?.label ?? placeholder}
          </span>
          <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
        </>
      }
    >
      {(close) =>
        options.map((option) => (
          <MenuItem
            key={option.value}
            checked={option.value === value}
            onSelect={() => {
              close();
              if (option.value !== value) onChange(option.value);
            }}
          >
            {option.label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}

// Dialogs

/**
 * A modal dialog: the page behind is inert, the close button, Escape and
 * `Cancel` close it, and focus goes back to what opened it. `footer` holds
 * its buttons, at its foot on the right.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
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
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="dialog__head">
        <h2 id={id} className="ac-dialog__title">
          {title}
        </h2>
        <button type="button" className="dialog__close" onClick={onClose} aria-label="Close">
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
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={pending} onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      <p className="ac-dialog__body">{sentence}</p>
      {error != null && (
        <p className="ac-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

// Long text

const PREVIEW = 4 * 1024;

/** Text as text, its first 4 KB and `Show all 30.2 KB` when longer. */
export function LongText({ text, mono = false }: { text: string; mono?: boolean }) {
  const [all, setAll] = useState(false);
  const total = byteLength(text);
  const shown = all || total <= PREVIEW ? text : firstBytes(text, PREVIEW);
  const more = shown !== text && (
    <button type="button" className="link-button json__more" onClick={() => setAll(true)}>
      Show all {sizeText(total)}
    </button>
  );
  if (mono) {
    return (
      <div className="json long-text">
        <pre className="json__code">{shown}</pre>
        {more}
      </div>
    );
  }
  return (
    <div className="long-text">
      <pre className="prose-text">{shown}</pre>
      {more}
    </div>
  );
}

/** JSON shown at most: two million characters, 64 levels deep. */
const JSON_ALL = 2_000_000;

/**
 * JSON, pretty, as text, in the reference's code block: its first 4 KB,
 * written within bounds, and `Show all …` for the rest up to a bound. Never
 * throws.
 */
export function JsonBlock({ value }: { value: unknown }) {
  const [all, setAll] = useState(false);
  const preview = useMemo(() => boundedJson(value, { maxChars: PREVIEW }), [value]);
  // Measured, within its bound, only when the preview is cut.
  const full = useMemo(
    () => (preview.complete ? preview : boundedJson(value, { maxChars: JSON_ALL })),
    [value, preview],
  );
  const shown = all ? full : preview;
  return (
    <div className="json long-text">
      <pre className="json__code">{shown.text}</pre>
      {!all && !preview.complete && (
        <button type="button" className="link-button json__more" onClick={() => setAll(true)}>
          Show all {sizeText(byteLength(full.text))}
        </button>
      )}
    </div>
  );
}

export { errorText };
