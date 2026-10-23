/** The frame every page sits in: the header, the sidebar and the search dialog. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  IconArrowUpRight,
  IconDeviceDesktop,
  IconMenu2,
  IconMoon,
  IconSun,
  IconX,
} from '@tabler/icons-react';
import { hrefOf, sections } from '../nav';
import { site } from '../site';
import { setTheme, useTheme, type Theme } from '../lib/theme';
import { SearchButton, SearchDialog, useSearchShortcut } from './Search';

export function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const openSearch = useCallback(() => {
    setMenuOpen(false);
    setSearchOpen(true);
  }, []);
  useSearchShortcut(openSearch);

  useEffect(() => setMenuOpen(false), [pathname]);
  // Keep the current page's link in view in a sidebar taller than the window.
  useEffect(() => {
    const sidebar = document.getElementById('sidebar');
    const link = sidebar?.querySelector<HTMLElement>('.nav-link[data-status="active"]');
    if (!sidebar || !link) return;
    const top = link.offsetTop; // The sidebar is the link's offset parent.
    if (
      top < sidebar.scrollTop ||
      top + link.offsetHeight > sidebar.scrollTop + sidebar.clientHeight
    ) {
      sidebar.scrollTop = top - sidebar.clientHeight / 3;
    }
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="shell" data-menu-open={menuOpen || undefined}>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="header">
        <button
          type="button"
          className="icon-button menu-toggle"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <IconX size={20} stroke={1.6} /> : <IconMenu2 size={20} stroke={1.6} />}
        </button>
        <Link to="/" className="brand" aria-label={`${site.name} docs home`}>
          <img src="/acentric-mark.png" width="28" height="28" alt="" />
          <span className="brand-name">{site.name}</span>
          <span className="brand-docs">Docs</span>
        </Link>
        <div className="header-search">
          <SearchButton onOpen={openSearch} />
        </div>
        <nav className="header-links" aria-label="Elsewhere">
          <a href={site.homeUrl} target="_blank" rel="noreferrer">
            acentric.dev
            <IconArrowUpRight size={14} stroke={1.6} aria-hidden />
          </a>
          <ThemeToggle />
        </nav>
      </header>

      <aside id="sidebar" className="sidebar" aria-label="Documentation">
        <nav>
          {sections.map((section) => (
            <section key={section.title} className="nav-section">
              <h2>{section.title}</h2>
              <ul>
                {section.pages.map((page) => (
                  <li key={page.slug}>
                    <Link
                      to={hrefOf(page)}
                      activeOptions={{ exact: true, includeHash: false }}
                      className="nav-link"
                    >
                      {page.label ?? page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </aside>
      <div className="scrim" aria-hidden onClick={() => setMenuOpen(false)} />

      <div className="main">{children}</div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

const THEMES: { value: Theme; label: string; icon: typeof IconSun }[] = [
  { value: 'system', label: 'System', icon: IconDeviceDesktop },
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
];

function ThemeToggle() {
  const theme = useTheme();
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon size={15} stroke={1.6} />
        </button>
      ))}
    </div>
  );
}
