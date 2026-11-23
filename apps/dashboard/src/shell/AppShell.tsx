// The signed-in app: the sidebar, a slim top bar with the collapse control and
// where you are, and the page. The sidebar collapses to an icon rail (⌘B or
// Ctrl+B, remembered), and on a phone it becomes a drawer.

import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMenu2,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation, type LinkOptions } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useMe } from '../me.ts';
import { session } from '../session.ts';
import { tabAt } from './nav.ts';
import { NotFound } from './NotFound.tsx';
import { Sidebar } from './Sidebar.tsx';

const PRODUCT = 'Acentric';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

type Crumb = { label: string; link?: LinkOptions; mono?: boolean; title?: string };

/** Where you are, from the route: the tab. */
function useCrumbs(): Crumb[] {
  const pathname = useLocation({ select: (l) => l.pathname });
  const tab = tabAt(pathname)?.tab;
  return tab === undefined ? [] : [{ label: tab.name, link: { to: tab.path } }];
}

export function AppShell() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const me = useMe();
  const collapsed = useSyncExternalStore(session.onPreferenceChange, session.sidebarCollapsed);
  const [drawer, setDrawer] = useState(false);
  const phone = useMedia('(max-width: 768px)');
  const crumbs = useCrumbs();
  // A page of a tab this person may not see is not here.
  const here = tabAt(pathname);
  const hidden = here !== undefined && me.data !== undefined && !here.tab.shown(me.data);

  const toggle = useCallback(
    () => (phone ? setDrawer((open) => !open) : session.toggleSidebar()),
    [phone],
  );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [toggle]);

  // A page change closes the phone drawer.
  useEffect(() => setDrawer(false), [pathname]);

  const title = crumbs.at(-1);
  const titleText = title?.title ?? title?.label;
  useEffect(() => {
    document.title = titleText ? `${titleText} | ${PRODUCT}` : PRODUCT;
  }, [titleText]);

  // On a phone the sidebar is a full drawer, whatever it is on a desktop.
  const rail = collapsed && !phone;

  return (
    <div
      className="ac-root shell"
      data-collapsed={rail || undefined}
      data-drawer={drawer || undefined}
    >
      <Sidebar me={me.data} collapsed={rail} />
      <div className="shell__scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            className="topbar__toggle"
            onClick={toggle}
            aria-label={phone ? 'Open menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={phone ? undefined : `${collapsed ? 'Expand' : 'Collapse'} sidebar (⌘B)`}
          >
            <IconMenu2 className="topbar__menu" size={18} stroke={1.75} aria-hidden="true" />
            {collapsed ? (
              <IconLayoutSidebarLeftExpand
                className="topbar__side"
                size={18}
                stroke={1.75}
                aria-hidden="true"
              />
            ) : (
              <IconLayoutSidebarLeftCollapse
                className="topbar__side"
                size={18}
                stroke={1.75}
                aria-hidden="true"
              />
            )}
          </button>
          <span className="topbar__rule" aria-hidden="true" />
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <span className="crumbs__sep" aria-hidden="true">
                    /
                  </span>
                )}
                {i === crumbs.length - 1 ? (
                  <span
                    className={`crumbs__item crumbs__item--current${crumb.mono === true ? ' crumbs__item--mono' : ''}`}
                    aria-current="page"
                    title={crumb.title}
                  >
                    {crumb.label}
                  </span>
                ) : crumb.link !== undefined ? (
                  <Link
                    {...crumb.link}
                    activeOptions={{ exact: true }}
                    className="crumbs__item crumbs__link"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="crumbs__item">{crumb.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        </header>
        <main id="main" className="page" tabIndex={-1}>
          {hidden ? <NotFound /> : <Outlet />}
        </main>
      </div>
    </div>
  );
}
