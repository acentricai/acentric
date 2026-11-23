// The person signed in, at the foot of the sidebar: their email, and a menu with the theme and
// signing out. Signing out ends this browser's session at the server.

import { IconLogout, IconSelector } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';

import { api, queryClient } from '../api.ts';
import { usePopover } from '../popover.ts';
import { tellOtherTabs } from '../session.ts';
import { ThemeToggle } from '../theme.tsx';

export function UserMenu({ email, collapsed }: { email: string; collapsed: boolean }) {
  const navigate = useNavigate();
  const menu = usePopover();
  const signOut = async () => {
    menu.close();
    // Signed out here whatever the server says: the cookie it clears is its own to clear.
    await api.call('auth.signOut').catch(() => undefined);
    queryClient.clear();
    tellOtherTabs();
    await navigate({ to: '/sign-in', replace: true });
  };
  const initials = email
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="side__footer" ref={menu.container}>
      <button
        ref={menu.trigger}
        type="button"
        className="me"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={collapsed ? `Signed in as ${email}` : undefined}
        onClick={() => menu.setOpen((open) => !open)}
      >
        <span className="me__avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="me__email">{email}</span>
        <IconSelector className="me__chevron" size={14} stroke={1.75} aria-hidden="true" />
      </button>
      {menu.open && (
        <div className="pop me__pop" role="menu" aria-label="Account">
          {/* The button shows the email unless the sidebar is collapsed to icons. */}
          {collapsed && <span className="pop__heading pop__heading--email">{email}</span>}
          <div className="pop__row">
            <span className="pop__text">Theme</span>
            <ThemeToggle />
          </div>
          <div className="pop__rule" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="pop__item"
            onClick={() => void signOut()}
          >
            <IconLogout size={16} stroke={1.75} aria-hidden="true" />
            <span className="pop__text">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
