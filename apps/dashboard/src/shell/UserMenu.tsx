// The person signed in, at the foot of the sidebar: their email, and a menu with the account
// page, the theme and signing out. Signing out ends this browser's session at the server.

import { IconLogout, IconSelector, IconUserCircle } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';

import { Avatar } from '../avatar.tsx';
import type { Me } from '../me.ts';
import { usePopover } from '../popover.ts';
import { signOut as endSession } from '../sign-out.ts';
import { ThemeToggle } from '../theme.tsx';

export function UserMenu({ me, collapsed }: { me: Me | undefined; collapsed: boolean }) {
  const email = me?.email ?? '';
  const navigate = useNavigate();
  const menu = usePopover();
  const signOut = async () => {
    menu.close();
    await endSession();
    await navigate({ to: '/sign-in', replace: true });
  };

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
        <Avatar user={me?.user ?? ''} photo={me?.photo} name={me?.displayName ?? email} />
        <span className="me__email">{email}</span>
        <IconSelector className="me__chevron" size={14} stroke={1.75} aria-hidden="true" />
      </button>
      {menu.open && (
        <div className="pop me__pop" role="menu" aria-label="Account">
          {/* The button shows the email unless the sidebar is collapsed to icons. */}
          {collapsed && <span className="pop__heading pop__heading--email">{email}</span>}
          <button
            type="button"
            role="menuitem"
            className="pop__item"
            onClick={() => {
              menu.close();
              void navigate({ to: '/account' });
            }}
          >
            <IconUserCircle size={16} stroke={1.75} aria-hidden="true" />
            <span className="pop__text">Account</span>
          </button>
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
