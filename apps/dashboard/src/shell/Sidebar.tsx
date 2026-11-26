// The sidebar: the mark and the engine, the grouped tabs, Settings and the account.
// One hover highlight shared by every row, sliding and interruptible; an
// active line that settles onto the current tab on a critically damped curve;
// icons that press in. Positions are measured from the rendered rows, so
// folding a section, collapsing to the rail or hiding a section the org may
// not use keeps them true.

import { IconArrowLeft, IconChevronDown } from '@tabler/icons-react';
import { Link, useLocation } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { agentAt, agentSection } from '../agents/pages/dashboard.tsx';
import type { Me } from '../me.ts';
import { type Section, type Tab } from '../sections.ts';
import { session } from '../session.ts';
import { onTab, visibleSections } from './nav.ts';
import { SettingsButton } from './Settings.tsx';
import { UserMenu } from './UserMenu.tsx';

type Box = { y: number; h: number; x: number; w: number };

export function Sidebar({ me, collapsed }: { me: Me | undefined; collapsed: boolean }) {
  // With an agent open, the sidebar is that agent's own: its tabs, and the way back.
  const agent = useLocation({ select: (l) => agentAt(l.pathname) });
  const sections = visibleSections(me, agent === undefined ? undefined : [agentSection(agent)]);
  return (
    <aside className="side" data-collapsed={collapsed || undefined} aria-label="Sidebar">
      <div className="side__header">
        <Link to="/" className="side__brand" aria-label="Acentric">
          <img src="/acentric-mark-cropped.png" alt="" className="side__mark" />
        </Link>
        {agent !== undefined && (
          <Link
            to="/agents"
            className="side__back"
            aria-label="Back to Dashboard"
            title={collapsed ? 'Back to Dashboard' : undefined}
          >
            <IconArrowLeft size={14} stroke={1.75} aria-hidden="true" />
            <span className="side__back-text">Back to Dashboard</span>
          </Link>
        )}
      </div>
      <Navigation sections={sections} collapsed={collapsed} />
      <SettingsButton collapsed={collapsed} />
      <UserMenu me={me} collapsed={collapsed} />
    </aside>
  );
}

function Navigation({
  sections,
  collapsed,
}: {
  sections: ReadonlyArray<Section>;
  collapsed: boolean;
}) {
  const pathname = useLocation({ select: (l) => l.pathname });
  const nav = useRef<HTMLElement>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());
  // `tx`, `ty`: where the collapsed rail's tooltip goes, in window coordinates.
  const [hover, setHover] = useState<
    (Box & { visible: boolean; label: string; tx: number; ty: number }) | null
  >(null);
  const [active, setActive] = useState<(Box & { instant: boolean }) | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const folded = useSyncExternalStore(session.onPreferenceChange, session.folded);

  const activeTab = sections
    .flatMap((section) => section.tabs.map((tab) => ({ tab, section })))
    .find(({ tab }) => onTab(pathname, tab));

  const measure = useCallback((el: HTMLElement): Box => {
    const root = nav.current!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      y: box.top - root.top + nav.current!.scrollTop,
      h: box.height,
      x: box.left - root.left,
      w: box.width,
    };
  }, []);

  // The active line follows the current tab. A route change animates it; a
  // layout change (folding, collapsing, resizing) moves it in step.
  const activeId = activeTab?.tab.id;
  const activeSection = activeTab?.section.id;
  const placeActive = useCallback(
    (instant: boolean) => {
      const el = activeId === undefined ? undefined : links.current.get(activeId);
      const hidden =
        el === undefined ||
        (activeSection !== undefined && folded[activeSection] === true && !collapsed);
      const next = hidden || el === undefined ? null : { ...measure(el), instant };
      // Only a real move updates state, so measuring never loops.
      setActive((current) =>
        current && next && current.y === next.y && current.h === next.h ? current : next,
      );
    },
    [activeId, activeSection, folded, collapsed, measure],
  );

  useLayoutEffect(() => placeActive(false), [pathname, placeActive]);

  useEffect(() => {
    const target = nav.current;
    if (target === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => placeActive(true));
    observer.observe(target);
    target.querySelectorAll('.nav__list').forEach((list) => observer.observe(list));
    return () => observer.disconnect();
  }, [placeActive]);

  const show = (el: HTMLElement, label: string) => {
    const rect = el.getBoundingClientRect();
    setHover({
      ...measure(el),
      visible: true,
      label,
      tx: rect.right + 10,
      ty: rect.top + rect.height / 2,
    });
  };

  return (
    <nav
      ref={nav}
      className="nav"
      aria-label="Main"
      data-keyboard={keyboard || undefined}
      style={
        {
          '--hl-y': `${hover?.y ?? 0}px`,
          '--hl-h': `${hover?.h ?? 32}px`,
          '--active-y': `${active?.y ?? 0}px`,
          '--active-h': `${active?.h ?? 32}px`,
        } as CSSProperties
      }
      onPointerLeave={() => setHover((h) => (h ? { ...h, visible: false } : h))}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setHover((h) => (h ? { ...h, visible: false } : h));
      }}
      onKeyDown={() => setKeyboard(true)}
      onPointerDown={() => setKeyboard(false)}
    >
      <span
        className="nav__highlight"
        data-visible={hover?.visible || undefined}
        aria-hidden="true"
      />
      <span
        className="nav__active-line"
        data-instant={active?.instant || undefined}
        hidden={!active}
        aria-hidden="true"
      />
      {collapsed &&
        hover &&
        createPortal(
          <span
            className="nav__tooltip"
            role="tooltip"
            data-visible={hover.visible || undefined}
            style={{ left: hover.tx, top: hover.ty }}
          >
            {hover.label}
          </span>,
          document.body,
        )}

      {sections.map((section, index) => {
        const isFolded = !collapsed && folded[section.id] === true;
        return (
          <div className="nav__section" key={section.id} data-folded={isFolded || undefined}>
            {index > 0 && <div className="nav__separator" role="separator" />}
            <div
              className="nav__group"
              role={section.label === undefined ? undefined : 'group'}
              aria-label={section.label}
            >
              {section.label !== undefined && (
                <button
                  type="button"
                  className="nav__label"
                  aria-expanded={!isFolded}
                  onClick={() => session.toggleFolded(section.id)}
                  onPointerEnter={() => setHover((h) => (h ? { ...h, visible: false } : h))}
                  tabIndex={collapsed ? -1 : 0}
                >
                  <span>{section.label}</span>
                  <IconChevronDown
                    className="nav__fold"
                    size={14}
                    stroke={1.75}
                    aria-hidden="true"
                  />
                </button>
              )}
              <div className="nav__fold-body">
                <ul className="nav__list">
                  {section.tabs.map((tab) => (
                    <NavItem
                      key={tab.id}
                      tab={tab}
                      active={activeTab?.tab.id === tab.id}
                      inert={isFolded}
                      register={(el) => {
                        if (el) links.current.set(tab.id, el);
                        else links.current.delete(tab.id);
                      }}
                      onHover={(event) => {
                        if (event.pointerType !== 'mouse') return;
                        setKeyboard(false);
                        show(event.currentTarget, tab.name);
                      }}
                      onFocusVisible={(el) => {
                        setKeyboard(true);
                        show(el, tab.name);
                      }}
                    />
                  ))}
                </ul>
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function NavItem({
  tab,
  active,
  inert,
  register,
  onHover,
  onFocusVisible,
}: {
  tab: Tab;
  active: boolean;
  inert: boolean;
  register: (el: HTMLAnchorElement | null) => void;
  onHover: (event: PointerEvent<HTMLAnchorElement>) => void;
  onFocusVisible: (el: HTMLAnchorElement) => void;
}) {
  const Icon = active ? tab.activeIcon : tab.icon;
  return (
    <li>
      <Link
        to={tab.path}
        ref={register}
        className="nav__link"
        // Marked from the path this tab covers, not the link's own match.
        activeProps={{}}
        activeOptions={{ exact: tab.exact === true }}
        aria-current={active ? 'page' : undefined}
        aria-label={tab.name}
        tabIndex={inert ? -1 : undefined}
        onPointerEnter={onHover}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) onFocusVisible(event.currentTarget);
        }}
      >
        <span className="nav__icon">
          <Icon size={18} stroke={1.75} aria-hidden="true" />
        </span>
        <span className="nav__text">{tab.name}</span>
      </Link>
    </li>
  );
}
