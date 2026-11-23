// Light or dark, as two icon buttons. Until someone picks one, the dashboard
// follows the system, and the button for whichever theme is showing reads as
// chosen; picking one sets it for this browser. Kept in session.ts.

import { IconMoon, IconSun, type Icon } from '@tabler/icons-react';
import { useSyncExternalStore } from 'react';

import { session, type Theme } from './session.ts';

const DARK = '(prefers-color-scheme: dark)';

const subscribeSystem = (change: () => void) => {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(DARK);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};

const systemDark = () => typeof matchMedia === 'function' && matchMedia(DARK).matches;

/** The theme chosen in this browser, or `system`. */
export function useTheme(): Theme {
  return useSyncExternalStore(session.onPreferenceChange, session.theme);
}

export function setTheme(theme: Theme): void {
  session.setTheme(theme);
}

const OPTIONS: ReadonlyArray<readonly ['light' | 'dark', string, Icon]> = [
  ['light', 'Light', IconSun],
  ['dark', 'Dark', IconMoon],
];

export function ThemeToggle() {
  const theme = useTheme();
  const dark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  const showing = theme === 'system' ? (dark ? 'dark' : 'light') : theme;

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(([value, label, Glyph]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={showing === value}
          aria-label={label}
          title={label}
          className="theme-toggle__option"
          onClick={() => setTheme(value)}
        >
          <Glyph size={15} stroke={1.75} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
