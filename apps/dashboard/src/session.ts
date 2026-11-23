// What the browser keeps of the dashboard: the theme, and how the sidebar is laid out. The session
// itself is the server's cookie, which the page cannot read. Signing in or out in one tab is told
// to the others, which then ask the server again who is signed in; a change of the theme or the
// sidebar in one tab is followed by the others.

const THEME = 'acentric.theme';
const SIDEBAR = 'acentric.sidebar';
const FOLDED = 'acentric.folded';

export type Theme = 'system' | 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is off: it lasts as long as the page.
  }
}

/** Called whenever the theme or the sidebar's layout changes, here or in another tab. */
const preferenceListeners = new Set<() => void>();
function preferencesChanged(): void {
  for (const listener of preferenceListeners) listener();
}

/** The folded sections, read once per stored value so a snapshot keeps its identity. */
let foldedRaw: string | null = null;
let foldedValue: Readonly<Record<string, boolean>> = {};
function readFolded(): Readonly<Record<string, boolean>> {
  const raw = read(FOLDED);
  if (raw === foldedRaw) return foldedValue;
  foldedRaw = raw;
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    foldedValue =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, boolean] => entry[1] === true),
          )
        : {};
  } catch {
    foldedValue = {};
  }
  return foldedValue;
}

export const session = {
  theme(): Theme {
    const chosen = read(THEME);
    return chosen === 'light' || chosen === 'dark' ? chosen : 'system';
  },
  setTheme(theme: Theme): void {
    write(THEME, theme === 'system' ? null : theme);
    applyTheme(theme);
    preferencesChanged();
  },
  /** Whether the sidebar is collapsed to its icon rail. */
  sidebarCollapsed: (): boolean => read(SIDEBAR) === 'collapsed',
  toggleSidebar(): void {
    write(SIDEBAR, session.sidebarCollapsed() ? null : 'collapsed');
    preferencesChanged();
  },
  /** The sidebar's folded sections, by ID. */
  folded: readFolded,
  toggleFolded(section: string): void {
    const next = { ...readFolded() };
    if (next[section] === true) delete next[section];
    else next[section] = true;
    write(FOLDED, Object.keys(next).length === 0 ? null : JSON.stringify(next));
    preferencesChanged();
  },
  /** Listens for any change of the theme or the sidebar; returns the way to stop. */
  onPreferenceChange(listener: () => void): () => void {
    preferenceListeners.add(listener);
    return () => preferenceListeners.delete(listener);
  },
};

/** The theme chosen in this browser, or `system`. */
export const theme = (): Theme => session.theme();

/** Sets the theme on the document: `data-theme` for a choice, nothing to follow the system. */
export function applyTheme(chosen: Theme): void {
  if (chosen === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = chosen;
}

const CHANNEL = 'acentric.session';

/** Tells the other tabs that who is signed in changed. */
export function tellOtherTabs(): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // A browser with no channels: the other tabs find out at their next call.
  }
}

/**
 * Calls back when another tab signed in or out, and follows its theme and sidebar; returns the
 * way to stop.
 */
export function onOtherTab(changed: () => void): () => void {
  const preferences = (event: StorageEvent) => {
    if (event.key === THEME || event.key === null) applyTheme(session.theme());
    if (
      event.key === THEME ||
      event.key === SIDEBAR ||
      event.key === FOLDED ||
      event.key === null
    ) {
      preferencesChanged();
    }
  };
  window.addEventListener('storage', preferences);
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener('message', changed);
  } catch {
    // As above.
  }
  return () => {
    window.removeEventListener('storage', preferences);
    channel?.close();
  };
}
